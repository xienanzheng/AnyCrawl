/**
 * CDP-based Turnstile Solver
 *
 * 使用 Chrome DevTools Protocol 拦截和解决 Cloudflare Turnstile
 * 支持 Puppeteer 和 Playwright
 *
 * 核心策略：通过 CDP 拦截 challenges.cloudflare.com 的脚本请求，
 * 延迟其加载直到我们的拦截脚本准备好，从而绕过 preload 机制
 */

import { log } from '@anycrawl/libs';
import { Solver } from '@2captcha/captcha-solver';

export interface TurnstileParams {
    sitekey: string;
    pageurl: string;
    data?: string;
    pagedata?: string;
    action?: string;
    userAgent?: string;
    isChallengePage?: boolean;
}

export interface CDPTurnstileSolverOptions {
    apiKey?: string;
    timeout?: number;
    blockChallengeScripts?: boolean;
    navigationTimeout?: number;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
}

// Inject script - 在 turnstile 脚本加载前就设置好代理
// 这个脚本会创建一个假的 turnstile 对象来拦截 render 调用
const TURNSTILE_PROXY_SCRIPT = `
(function() {
    // 如果已经解决了，不再安装代理
    if (window.__turnstileSolved) return;

    // 防止重复注入
    if (window.__turnstileProxyInstalled) return;
    window.__turnstileProxyInstalled = true;

    console.log('[TurnstileSolver] Installing turnstile proxy...');

    // 清除 console.clear 以保留日志
    console.clear = () => console.log('[TurnstileSolver] Console clear blocked');

    // 状态标记
    window.__turnstileSolving = false;
    window.__turnstileSolved = false;
    window.__turnstileParams = null;
    window.__turnstileReady = false;

    // 存储原始 turnstile 对象（如果已存在）
    let originalTurnstile = window.turnstile;

    // 创建代理 turnstile 对象
    const proxyTurnstile = {
        __isProxy: true,
        __intercepted: false,
        __pendingRenders: [],

        render: function(container, options) {
            // 如果已经解决了，不再拦截
            if (window.__turnstileSolved) return 'already-solved';

            console.log('[TurnstileSolver] turnstile.render intercepted!');

            // 提取参数
            const params = {
                sitekey: options.sitekey,
                pageurl: window.location.href,
                data: options.cData,
                pagedata: options.chlPageData,
                action: options.action,
                userAgent: navigator.userAgent,
                json: 1
            };

            console.log('intercepted-params:' + JSON.stringify(params));

            // 保存回调
            window.cfCallback = options.callback;
            window.__turnstileParams = params;
            window.__turnstileSolving = true;

            // 不调用原始 render - 我们通过 2captcha 处理
            return 'proxy-widget-id';
        },

        getResponse: function(widgetId) {
            return null;
        },

        reset: function(widgetId) {
            console.log('[TurnstileSolver] turnstile.reset called');
        },

        remove: function(widgetId) {
            console.log('[TurnstileSolver] turnstile.remove called');
        },

        isExpired: function(widgetId) {
            return false;
        },

        execute: function(container, options) {
            if (window.__turnstileSolved) return 'already-solved';
            console.log('[TurnstileSolver] turnstile.execute intercepted!');
            return this.render(container, options);
        }
    };

    // 使用 Object.defineProperty 来拦截 turnstile 的设置
    let _turnstile = proxyTurnstile;

    Object.defineProperty(window, 'turnstile', {
        get: function() {
            return _turnstile;
        },
        set: function(val) {
            console.log('[TurnstileSolver] Intercepted turnstile assignment');
            // 保存原始对象但不使用它
            originalTurnstile = val;
            // 保持使用我们的代理
            _turnstile = proxyTurnstile;
        },
        configurable: true
    });

    window.__turnstileReady = true;
    console.log('[TurnstileSolver] Turnstile proxy installed successfully');
})();
`;

// 备用轮询脚本 - 用于 preload 已经加载的情况
const TURNSTILE_POLLING_SCRIPT = `
(function() {
    // 如果已经解决了，不再安装
    if (window.__turnstileSolved) return;

    if (window.__turnstilePollingInstalled) return;
    window.__turnstilePollingInstalled = true;

    console.log('[TurnstileSolver] Installing polling fallback...');

    window.__turnstileSolving = window.__turnstileSolving || false;
    window.__turnstileSolved = window.__turnstileSolved || false;

    // 快速轮询检查 turnstile
    const checkInterval = setInterval(() => {
        // 如果已经解决了，停止轮询
        if (window.__turnstileSolved) {
            clearInterval(checkInterval);
            return;
        }

        if (window.turnstile && !window.turnstile.__isProxy && !window.turnstile.__intercepted) {
            window.turnstile.__intercepted = true;
            clearInterval(checkInterval);

            console.log('[TurnstileSolver] Found real turnstile, overriding render...');

            const originalRender = window.turnstile.render;
            window.turnstile.render = function(container, options) {
                // 如果已经解决了，不再拦截
                if (window.__turnstileSolved) return 'already-solved';

                console.log('[TurnstileSolver] turnstile.render intercepted (polling)!');

                const params = {
                    sitekey: options.sitekey,
                    pageurl: window.location.href,
                    data: options.cData,
                    pagedata: options.chlPageData,
                    action: options.action,
                    userAgent: navigator.userAgent,
                    json: 1
                };

                console.log('intercepted-params:' + JSON.stringify(params));
                window.cfCallback = options.callback;
                window.__turnstileSolving = true;

                // 不调用原始 render
                return 'intercepted-widget';
            };
        }
    }, 1);

    // 10秒后停止轮询
    setTimeout(() => clearInterval(checkInterval), 10000);
})();
`;

/**
 * CDP-based Turnstile Solver
 */
export class CDPTurnstileSolver {
    private solver: Solver | null = null;
    private apiKey: string | null;
    private timeout: number;
    private solving = false;
    private solved = false;
    private detected = false;
    private blockChallengeScripts: boolean;
    private cdpSession: any = null;
    private pendingRequests: Map<string, any> = new Map();
    private navigationTimeout: number;
    private waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

    constructor(options: CDPTurnstileSolverOptions = {}) {
        this.apiKey = options.apiKey || process.env.CAPTCHA_SOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY || null;
        this.timeout = options.timeout || 180000;
        this.blockChallengeScripts = options.blockChallengeScripts ?? true;
        this.navigationTimeout = options.navigationTimeout || parseInt(process.env.ANYCRAWL_NAV_TIMEOUT || '30000', 10);
        this.waitUntil = options.waitUntil || (process.env.ANYCRAWL_NAV_WAIT_UNTIL as any) || 'domcontentloaded';

        if (this.apiKey) {
            this.solver = new Solver(this.apiKey);
        }
    }

    getNavigationOptions() {
        return {
            timeout: this.navigationTimeout,
            waitUntil: this.waitUntil,
        };
    }

    isAvailable(): boolean {
        return this.solver !== null;
    }

    isSolving(): boolean {
        return this.solving;
    }

    isSolved(): boolean {
        return this.solved;
    }

    isDetected(): boolean {
        return this.detected;
    }

    /**
     * Check if turnstile is detected on the page
     */
    async checkDetected(page: any): Promise<boolean> {
        try {
            const detected = await page.evaluate(() => {
                return !!(
                    (window as any).__turnstileDetected ||
                    (window as any).__turnstileSolving ||
                    (window as any).turnstile ||
                    (window as any)._cf_chl_opt
                );
            });
            if (detected) {
                this.detected = true;
            }
            return detected;
        } catch {
            return false;
        }
    }

    /**
     * Wait for turnstile to be solved (with timeout)
     */
    async waitForSolve(page: any, timeoutMs: number = 180000): Promise<boolean> {
        const startTime = Date.now();
        const checkInterval = 1000;

        log.info(`[CDPTurnstileSolver] Waiting for solve (timeout: ${timeoutMs}ms)...`);

        while (Date.now() - startTime < timeoutMs) {
            if (this.solved) {
                log.info('[CDPTurnstileSolver] Solve completed!');
                return true;
            }

            // Check page state
            try {
                const pageState = await page.evaluate(() => {
                    const title = document.title || '';
                    const isChallengePage =
                        title.includes('Just a moment') ||
                        title.includes('Checking') ||
                        title.includes('Please wait');

                    return {
                        solved: (window as any).__turnstileSolved,
                        solving: (window as any).__turnstileSolving,
                        title,
                        isChallengePage,
                    };
                });

                if (pageState.solved) {
                    this.solved = true;
                    log.info('[CDPTurnstileSolver] Page reports solved!');
                    return true;
                }

                // If no longer on challenge page, we're done
                if (!pageState.isChallengePage && pageState.solving) {
                    log.info(`[CDPTurnstileSolver] No longer on challenge page (title: "${pageState.title}"), assuming solved`);
                    this.solved = true;
                    return true;
                }

            } catch (e) {
                // Page might have navigated - this could mean success
                log.debug(`[CDPTurnstileSolver] Page evaluate error (may have navigated): ${e}`);
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        log.warning('[CDPTurnstileSolver] Solve timeout reached');
        return false;
    }

    /**
     * Setup CDP request interception to block/delay Cloudflare challenge scripts
     * This ensures our proxy script runs before the real turnstile loads
     */
    private async setupCDPInterception(page: any, isPlaywright: boolean): Promise<void> {
        if (!this.blockChallengeScripts) {
            return;
        }

        try {
            log.info('[CDPTurnstileSolver] Setting up CDP request interception...');

            if (isPlaywright) {
                // Playwright: use route to intercept requests
                await page.route('**/*', async (route: any) => {
                    const url = route.request().url();

                    // Block or delay challenges.cloudflare.com scripts
                    if (url.includes('challenges.cloudflare.com') &&
                        (url.includes('/turnstile/') || url.includes('/cdn-cgi/'))) {

                        log.info(`[CDPTurnstileSolver] Intercepted CF script: ${url}`);

                        // Check if our proxy is ready
                        try {
                            const proxyReady = await page.evaluate(() => {
                                return (window as any).__turnstileReady === true;
                            });

                            if (proxyReady) {
                                log.info('[CDPTurnstileSolver] Proxy ready, continuing request');
                                await route.continue();
                            } else {
                                // Wait a bit for proxy to be ready
                                log.info('[CDPTurnstileSolver] Waiting for proxy to be ready...');
                                await new Promise(resolve => setTimeout(resolve, 100));
                                await route.continue();
                            }
                        } catch {
                            // If we can't check, just continue
                            await route.continue();
                        }
                        return;
                    }

                    await route.continue();
                });
            } else {
                // Puppeteer: use CDP Fetch domain
                const client = await page.target().createCDPSession();
                this.cdpSession = client;

                await client.send('Fetch.enable', {
                    patterns: [
                        { urlPattern: '*challenges.cloudflare.com*', requestStage: 'Request' },
                        { urlPattern: '*cdn-cgi*turnstile*', requestStage: 'Request' }
                    ]
                });

                client.on('Fetch.requestPaused', async (event: any) => {
                    const { requestId, request } = event;
                    const url = request.url;

                    if (url.includes('challenges.cloudflare.com') ||
                        (url.includes('cdn-cgi') && url.includes('turnstile'))) {

                        log.info(`[CDPTurnstileSolver] CDP intercepted CF script: ${url}`);

                        // Small delay to ensure proxy script is ready
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }

                    try {
                        await client.send('Fetch.continueRequest', { requestId });
                    } catch (e) {
                        log.debug(`[CDPTurnstileSolver] Failed to continue request: ${e}`);
                    }
                });

                log.info('[CDPTurnstileSolver] CDP Fetch interception enabled');
            }
        } catch (e) {
            log.warning(`[CDPTurnstileSolver] Failed to setup CDP interception: ${e}`);
        }
    }

    /**
     * Setup solver on page - works with Puppeteer and Playwright
     * @param page - The page object
     * @param shouldRefresh - Whether to refresh the page after setup to trigger render interception
     */
    async setup(page: any, shouldRefresh: boolean = false): Promise<void> {
        if (!this.isAvailable()) {
            log.debug('[CDPTurnstileSolver] No API key configured, skipping setup');
            return;
        }

        try {
            // Detect engine type
            const isPlaywright = !!(page.context && typeof page.context === 'function');
            const isPuppeteer = !!(page.target && typeof page.target === 'function');

            log.info(`[CDPTurnstileSolver] Setting up for ${isPlaywright ? 'Playwright' : isPuppeteer ? 'Puppeteer' : 'Unknown'}`);

            // Setup console listener for params interception
            const handleConsole = async (msg: any) => {
                const text = typeof msg.text === 'function' ? msg.text() : String(msg);

                // Log all TurnstileSolver messages
                if (text.includes('[TurnstileSolver]')) {
                    log.info(`[CDPTurnstileSolver] Page: ${text}`);
                }

                // Match the official inject.js format: intercepted-params:
                if (text.includes('intercepted-params:')) {
                    if (this.solving || this.solved) {
                        log.debug('[CDPTurnstileSolver] Already solving/solved, skipping');
                        return;
                    }
                    this.solving = true;

                    try {
                        const paramsJson = text.split('intercepted-params:')[1];
                        const params = JSON.parse(paramsJson) as TurnstileParams;
                        log.info(`[CDPTurnstileSolver] Intercepted params: sitekey=${params.sitekey?.substring(0, 20)}...`);
                        await this.handleParams(page, params);
                    } catch (e) {
                        log.error(`[CDPTurnstileSolver] Error handling params: ${e}`);
                    } finally {
                        this.solving = false;
                    }
                }
            };

            page.on('console', handleConsole);

            // Inject BOTH scripts - proxy first, then polling as fallback
            if (isPlaywright) {
                // Setup CDP interception first
                await this.setupCDPInterception(page, true);

                // Then inject scripts
                await page.addInitScript(TURNSTILE_PROXY_SCRIPT);
                await page.addInitScript(TURNSTILE_POLLING_SCRIPT);
                log.debug('[CDPTurnstileSolver] Injected via addInitScript (Playwright)');
            } else if (isPuppeteer) {
                // Setup CDP interception first
                await this.setupCDPInterception(page, false);

                // Then inject scripts
                await page.evaluateOnNewDocument(TURNSTILE_PROXY_SCRIPT);
                await page.evaluateOnNewDocument(TURNSTILE_POLLING_SCRIPT);
                log.debug('[CDPTurnstileSolver] Injected via evaluateOnNewDocument (Puppeteer)');
            } else {
                // Fallback: try both
                try {
                    await page.evaluateOnNewDocument(TURNSTILE_PROXY_SCRIPT);
                    await page.evaluateOnNewDocument(TURNSTILE_POLLING_SCRIPT);
                } catch {
                    try {
                        await page.addInitScript(TURNSTILE_PROXY_SCRIPT);
                        await page.addInitScript(TURNSTILE_POLLING_SCRIPT);
                    } catch (e) {
                        log.error(`[CDPTurnstileSolver] Failed to inject script: ${e}`);
                    }
                }
            }

            log.info('[CDPTurnstileSolver] Setup complete');

            // Refresh page if requested to trigger render interception
            if (shouldRefresh) {
                log.info('[CDPTurnstileSolver] Refreshing page to trigger render interception...');
                try {
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
                    log.info('[CDPTurnstileSolver] Page refreshed, waiting for turnstile...');
                } catch (e) {
                    log.warning(`[CDPTurnstileSolver] Refresh failed: ${e}`);
                }
            }
        } catch (e) {
            log.error(`[CDPTurnstileSolver] Setup failed: ${e}`);
        }
    }

    /**
     * Handle intercepted Turnstile params - based on official 2captcha demo
     */
    private async handleParams(page: any, params: TurnstileParams): Promise<void> {
        if (!this.solver || !params.sitekey) {
            log.error('[CDPTurnstileSolver] No solver or sitekey');
            return;
        }

        log.info(`[CDPTurnstileSolver] Solving Turnstile: sitekey=${params.sitekey.substring(0, 20)}...`);

        try {
            const solveParams: any = {
                pageurl: params.pageurl,
                sitekey: params.sitekey,
            };

            // Add challenge-specific params if present
            if (params.data) solveParams.data = params.data;
            if (params.pagedata) solveParams.pagedata = params.pagedata;
            if (params.action) solveParams.action = params.action;

            log.info('[CDPTurnstileSolver] Calling 2captcha API...');
            const result = await this.solver.cloudflareTurnstile(solveParams);

            log.info(`[CDPTurnstileSolver] Solved! id=${result.id}, token=${result.data.substring(0, 30)}...`);

            const token = result.data;

            // Simple approach from official demo: just call cfCallback(token)
            const injectionResult = await page.evaluate((t: string) => {
                console.log('[TurnstileSolver] Injecting token via cfCallback...');

                if (typeof (window as any).cfCallback === 'function') {
                    (window as any).cfCallback(t);
                    (window as any).__turnstileSolved = true;
                    console.log('[TurnstileSolver] Token injected successfully!');
                    return 'success';
                }

                console.log('[TurnstileSolver] cfCallback not found!');
                return 'no-callback';
            }, token);

            log.info(`[CDPTurnstileSolver] Injection result: ${injectionResult}`);

            if (injectionResult === 'success') {
                this.solved = true;
                log.info('[CDPTurnstileSolver] Challenge solved!');
            }

        } catch (e) {
            log.error(`[CDPTurnstileSolver] Solve failed: ${e}`);
        }
    }

    /**
     * Cleanup CDP session
     */
    async cleanup(): Promise<void> {
        if (this.cdpSession) {
            try {
                await this.cdpSession.send('Fetch.disable');
            } catch {
                // Ignore cleanup errors
            }
            this.cdpSession = null;
        }
        this.pendingRequests.clear();
    }

    /**
     * Reset state for new page
     */
    reset(): void {
        this.solving = false;
        this.solved = false;
        this.detected = false;
        this.cleanup();
    }
}

export function createCDPSolver(): CDPTurnstileSolver {
    return new CDPTurnstileSolver();
}

export default CDPTurnstileSolver;
