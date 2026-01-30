import { AD_DOMAINS, log } from "@anycrawl/libs";
import { minimatch } from "minimatch";
import { Utils } from "../Utils.js";
import { BrowserName } from "crawlee";
import { ProgressManager } from "../managers/Progress.js";
import { JOB_TYPE_CRAWL } from "@anycrawl/libs";
import { CrawlLimitReachedError } from "../errors/index.js";
import { getOrCreateBandwidthTracker } from "./BandwidthTracker.js";
import { CDPTurnstileSolver, CloudflareSolver } from "../solvers/index.js";

export enum ConfigurableEngineType {
    CHEERIO = 'cheerio',
    PLAYWRIGHT = 'playwright',
    PUPPETEER = 'puppeteer'
}

/**
 * Engine configurator for applying engine-specific settings
 * Separates configuration logic from the main engine
 */
export class EngineConfigurator {
    /**
     * Apply engine-specific configurations
     */
    static configure(crawlerOptions: any, engineType: ConfigurableEngineType): any {
        const options = { ...crawlerOptions };

        // Apply common autoscaled pool options
        if (!options.autoscaledPoolOptions) {
            options.autoscaledPoolOptions = {
                isFinishedFunction: async () => false,
            };
        }

        // Apply browser-specific configurations
        if (this.isBrowserEngine(engineType)) {
            this.configureBrowserEngine(options, engineType);
        }

        // Apply engine-specific configurations
        switch (engineType) {
            case ConfigurableEngineType.PUPPETEER:
                this.configurePuppeteer(options);
                break;
            case ConfigurableEngineType.PLAYWRIGHT:
                this.configurePlaywright(options);
                break;
            case ConfigurableEngineType.CHEERIO:
                this.configureCheerio(options);
                break;
        }

        // Apply common hooks for ALL engines (including Cheerio)
        this.applyCommonHooks(options, engineType);

        return options;
    }

    /**
     * Apply common hooks for ALL engines (including Cheerio)
     */
    private static applyCommonHooks(options: any, engineType: ConfigurableEngineType): void {
        // Limit filter hook - abort requests that exceed crawl limit
        const limitFilterHook = async ({ request }: any) => {
            try {
                const userData: any = request.userData || {};
                const jobId = userData?.jobId;

                log.debug(`[limitFilterHook] Hook executed for request: ${request.url}, jobId: ${jobId}, type: ${userData.type}`);

                // Only apply limit filtering to crawl jobs
                if (jobId && userData.type === JOB_TYPE_CRAWL) {
                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Processing crawl job with limit filtering`);

                    const pm = ProgressManager.getInstance();
                    const limit = userData.crawl_options?.limit || 10;

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Fetching progress data: limit=${limit}`);

                    // Get current progress
                    const [enqueued, done, finalized, cancelled] = await Promise.all([
                        pm.getEnqueued(jobId),
                        pm.getDone(jobId),
                        pm.isFinalized(jobId),
                        pm.isCancelled(jobId),
                    ]);

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Progress data: enqueued=${enqueued}, done=${done}, finalized=${finalized}, cancelled=${cancelled}`);

                    // Check if we should abort this request
                    // Only abort if:
                    // 1. Job is finalized or cancelled
                    // 2. We've already completed enough pages (done >= limit)
                    if (finalized || cancelled || done >= limit) {
                        const reason = finalized ? 'finalized' :
                            cancelled ? 'cancelled' :
                                done >= limit ? 'limit reached' :
                                    'excessive queuing';

                        log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] ABORTING request - ${reason} (processed=${done}, enqueued=${enqueued}, limit=${limit})`);

                        // If we've reached the limit, try to finalize the job immediately
                        if (done >= limit && !finalized && !cancelled) {
                            log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] Attempting to finalize job after reaching limit (${done}/${limit})`);
                            try {
                                // Force finalize with the current limit value
                                const finalizeResult = await pm.tryFinalize(jobId, userData.queueName, {}, limit);
                                if (finalizeResult) {
                                    log.info(`[limitFilterHook] [${userData.queueName}] [${jobId}] Job finalized successfully after reaching limit`);
                                } else {
                                    log.warning(`[limitFilterHook] [${userData.queueName}] [${jobId}] Job finalization failed - may need manual intervention`);
                                }
                            } catch (finalizeError) {
                                log.warning(`[limitFilterHook] [${userData.queueName}] [${jobId}] Failed to finalize job after reaching limit: ${finalizeError}`);
                            }
                        }

                        log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Throwing CrawlLimitReachedError to prevent navigation`);

                        // Throw specialized error to abort the navigation and avoid proxy consumption
                        throw new CrawlLimitReachedError(jobId, reason, limit, done);
                    }

                    log.debug(`[limitFilterHook] [${userData.queueName}] [${jobId}] Request allowed to proceed - all checks passed`);
                } else {
                    log.debug(`[limitFilterHook] Skipping limit filtering - not a crawl job: jobId=${jobId}, type=${userData.type}`);
                }
            } catch (error) {
                // Re-throw CrawlLimitReachedError to abort navigation
                if (error instanceof CrawlLimitReachedError) {
                    log.debug(`[limitFilterHook] Re-throwing CrawlLimitReachedError: ${error.message}`);
                    throw error;
                }
                // Log and ignore other errors to avoid breaking navigation
                log.error(`[limitFilterHook] Unexpected error in limit filter hook: ${error}`);
            }
        };

        // Merge with existing preNavigationHooks
        const existingHooks = options.preNavigationHooks || [];

        options.preNavigationHooks = [limitFilterHook, ...existingHooks];

        log.debug(`[EngineConfigurator] Pre-navigation hooks configured for ${engineType}: total=${options.preNavigationHooks.length}, limitFilterHook=${options.preNavigationHooks.includes(limitFilterHook)}, existingHooks=${existingHooks.length}`);
    }

    private static isBrowserEngine(engineType: ConfigurableEngineType): boolean {
        return engineType === ConfigurableEngineType.PLAYWRIGHT ||
            engineType === ConfigurableEngineType.PUPPETEER;
    }

    private static configureBrowserEngine(options: any, engineType: ConfigurableEngineType): void {
        // Enforce viewport for browser engines
        const viewportHook = async ({ page }: any) => {
            try {
                if (!page) return;
                if ((page as any).__viewportApplied) return;
                (page as any).__viewportApplied = true;
                if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                    await page.setViewportSize({ width: 1920, height: 1080 });
                } else if (engineType === ConfigurableEngineType.PUPPETEER) {
                    try { await page.setViewport({ width: 1920, height: 1080 }); } catch { }
                }
            } catch { }
        };

        const bandwidthHook = async ({ page, request }: any) => {
            try {
                const jobId = request?.userData?.jobId;
                if (!jobId || !page) return;
                const tracker = await getOrCreateBandwidthTracker(page, engineType);
                tracker?.setJobContext(String(jobId));
            } catch {
                // ignore bandwidth tracking errors
            }
        };

        // Ad blocking configuration
        const adBlockingHook = async ({ page }: any) => {
            const shouldBlock = (url: string) => AD_DOMAINS.some(domain => url.includes(domain));

            if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                await page.route('**/*', (route: any) => {
                    const url = route.request().url();
                    if (shouldBlock(url)) {
                        log.info(`Aborting request to ${url}`);
                        return route.abort();
                    }
                    return route.continue();
                });
            } else if (engineType === ConfigurableEngineType.PUPPETEER) {
                await page.setRequestInterception(true);
                page.on('request', (req: any) => {
                    const url = req.url();
                    if (shouldBlock(url)) {
                        log.info(`Aborting request to ${url}`);
                        req.abort();
                    } else {
                        req.continue();
                    }
                });
            }
        };

        // set request timeout and faster navigation for each request
        const requestTimeoutHook = async ({ request }: any, gotoOptions: any) => {
            const timeoutMs = request.userData.options.timeout || (process.env.ANYCRAWL_NAV_TIMEOUT ? parseInt(process.env.ANYCRAWL_NAV_TIMEOUT) : 30_000);
            const waitUntil = (request.userData.options.wait_until || process.env.ANYCRAWL_NAV_WAIT_UNTIL || 'domcontentloaded') as any;
            log.debug(`Setting navigation for ${request.url} to timeout=${timeoutMs}ms waitUntil=${waitUntil}`);
            gotoOptions.timeout = timeoutMs;
            gotoOptions.waitUntil = waitUntil;
        };

        // Handle authentication to allow accessing 401 pages
        const authenticationHook = async ({ page }: any) => {
            if (engineType === ConfigurableEngineType.PUPPETEER) {
                try {
                    // First, set authenticate to null
                    await page.authenticate(null);

                    // Then use CDP to handle auth challenges
                    const client = await page.target().createCDPSession();

                    // Enable Fetch domain to intercept auth challenges
                    await client.send('Fetch.enable', {
                        handleAuthRequests: true,
                        patterns: [{ urlPattern: '*' }]
                    });

                    // Listen for auth required events
                    client.on('Fetch.authRequired', async (event: any) => {
                        log.debug(`Auth challenge intercepted for: ${event.request.url}`);

                        // Continue without auth to see 401 page content
                        try {
                            await client.send('Fetch.continueWithAuth', {
                                requestId: event.requestId,
                                authChallengeResponse: {
                                    response: 'CancelAuth'
                                }
                            });
                        } catch (err) {
                            log.debug(`Failed to cancel auth: ${err}`);
                            // Try to continue the request anyway
                            try {
                                await client.send('Fetch.continueRequest', {
                                    requestId: event.requestId
                                });
                            } catch (e) {
                                log.debug(`Failed to continue request: ${e}`);
                            }
                        }
                    });

                    // Also handle request paused events
                    client.on('Fetch.requestPaused', async (event: any) => {
                        // Continue all paused requests
                        try {
                            await client.send('Fetch.continueRequest', {
                                requestId: event.requestId
                            });
                        } catch (e) {
                            log.debug(`Failed to continue paused request: ${e}`);
                        }
                    });

                    log.debug('CDP auth handling enabled for Puppeteer');
                } catch (e) {
                    log.debug(`Failed to set up auth handling: ${e}`);
                }
            } else if (engineType === ConfigurableEngineType.PLAYWRIGHT) {
                // For Playwright, we might need different handling
                // Currently Playwright handles this better by default
            }
        };

        // Cloudflare Turnstile solver hook (pre-navigation - sets up CDP-based solver)
        const cloudflareSolverHook = async ({ page, request }: any) => {
            try {
                // Get API key from environment - if present, captcha solving is enabled
                const apiKey = process.env.CAPTCHA_SOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY;

                if (!apiKey) {
                    return;
                }

                // Skip if already set up
                if ((page as any).__cdpSolverSetup) {
                    return;
                }
                (page as any).__cdpSolverSetup = true;

                // Create and setup CDP-based solver with script blocking enabled
                const cdpSolver = new CDPTurnstileSolver({
                    apiKey,
                    blockChallengeScripts: true  // Enable blocking of CF scripts until proxy is ready
                });
                await cdpSolver.setup(page);

                // Store solver on page for access by 403 handler
                (page as any).__cdpTurnstileSolver = cdpSolver;
                (page as any).__captchaSolverEnabled = true;
                (page as any).__captchaSolverApiKey = apiKey;

                log.debug(`[CloudflareSolverHook] CDP Turnstile solver enabled with script blocking for ${request.url}`);

            } catch (error) {
                log.error(`[CloudflareSolverHook] Error setting up Turnstile solver: ${error instanceof Error ? error.message : String(error)}`);
            }
        };

        // Pre-navigation capture hook for preNav rules
        const preNavHook = async ({ page, request }: any) => {
            try {
                log.debug(`[preNavHook] called with page=${!!page}, request=${!!request}, url=${request?.url}`);
                if (!page || !request) {
                    log.warning(`[preNavHook] missing page or request, skipping`);
                    return;
                }
                const templateId = request.userData?.options?.template_id || request.userData?.templateId;
                log.debug(`[preNavHook] templateId=${templateId}, url=${request.url}`);
                if (!templateId) {
                    log.debug(`[preNavHook] no templateId found, skipping preNav setup`);
                    return;
                }

                // Load template to read preNav rules
                let template: any = null;
                try {
                    const { TemplateClient } = await import('@anycrawl/template-client');
                    const tc = new TemplateClient();
                    template = await tc.getTemplate(templateId);
                    log.debug(`[preNavHook] template loaded successfully: ${templateId}`);
                } catch (e) {
                    log.error(`[preNavHook] failed to load template ${templateId}: ${e}`);
                    return;
                }
                const preNav = template?.customHandlers?.preNav;
                if (!Array.isArray(preNav) || preNav.length === 0) {
                    log.debug(`[preNav] disabled or empty for templateId=${templateId} url=${request.url}`);
                    return;
                }

                type Rule = { type: 'exact' | 'glob' | 'regex'; pattern: string; re?: RegExp };
                type KeyCfg = { key: string; rules: Rule[]; done: boolean };

                const keyCfgs: KeyCfg[] = preNav.map((cfg: any) => ({
                    key: String(cfg?.key ?? ''),
                    rules: Array.isArray(cfg?.rules) ? cfg.rules.map((r: any) => {
                        const type = r?.type;
                        const pattern = String(r?.pattern ?? '');
                        if (type === 'regex') {
                            let re: RegExp | undefined;
                            try { re = new RegExp(`^(?:${pattern})$`); } catch { re = undefined; }
                            return { type: 'regex', pattern, re } as Rule;
                        }
                        if (type === 'glob') return { type: 'glob', pattern } as Rule;
                        return { type: 'exact', pattern } as Rule;
                    }) : [],
                    done: false,
                })).filter(k => k.key && k.rules.length > 0);

                if (keyCfgs.length === 0) {
                    log.debug(`[preNav] no valid rules after parsing for templateId=${templateId}`);
                    return;
                }

                const redis = Utils.getInstance().getRedisConnection();
                const jobId = request.userData?.jobId || 'unknown';
                const requestId = request.uniqueKey || `${Date.now()}`;
                console.log(`[preNav] enabled! jobId=${jobId}, requestId=${requestId}, keys=[${keyCfgs.map(k => k.key).join(', ')}]`);
                log.debug(`[preNav] enabled templateId=${templateId} jobId=${jobId} requestId=${requestId} keys=[${keyCfgs.map(k => k.key).join(', ')}]`);

                const matchUrl = (url: string, rules: Rule[]): boolean => {
                    for (const r of rules) {
                        if (r.type === 'exact') {
                            if (url === r.pattern) return true;
                        } else if (r.type === 'glob') {
                            try { if (minimatch(url, r.pattern, { dot: true })) return true; } catch { /* ignore */ }
                        } else if (r.type === 'regex') {
                            if (r.re && r.re.test(url)) return true;
                        }
                    }
                    return false;
                };

                // Response listener: match URL and capture payload
                const onResponse = async (response: any) => {
                    try {
                        const url = typeof response.url === 'function' ? response.url() : (response.url || '');
                        if (!url) return;
                        const verbose = process.env.ANYCRAWL_PRENAV_VERBOSE === '1' || process.env.ANYCRAWL_PRENAV_VERBOSE === 'true';

                        // Only continue (and optionally log) if the URL matches at least one pending rule
                        // or verbose mode is explicitly enabled
                        const candidate = keyCfgs.some(k => !k.done && matchUrl(url, k.rules));
                        if (!candidate && !verbose) return;
                        if (verbose) {
                            const pending = keyCfgs.filter(k => !k.done).length;
                            log.debug(`[preNav] response url=${url} pendingKeys=${pending}`);
                        }

                        // Find first not-done key that matches
                        for (const cfg of keyCfgs) {
                            if (cfg.done) continue;
                            if (!matchUrl(url, cfg.rules)) continue;
                            log.debug(`[preNav] matched key=${cfg.key} url=${url}`);

                            // Collect response metadata
                            let status = 0;
                            try { status = typeof response.status === 'function' ? response.status() : (response.status || 0); } catch { }
                            let headers: Record<string, string> = {};
                            try { headers = typeof response.headers === 'function' ? (await response.headers()) : (response.headers || {}); } catch { }
                            const lowerHeaders: Record<string, string> = {};
                            for (const [k, v] of Object.entries(headers || {})) lowerHeaders[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);

                            // Always capture text body
                            let body: string | undefined = undefined;
                            try {
                                body = await response.text();
                            } catch { /* ignore body parse errors */ }

                            // If body is empty (including content-length: 0), skip capturing for this response
                            const contentLengthHeader = (lowerHeaders as any)['content-length'];
                            let reportedLength = 0;
                            try { reportedLength = contentLengthHeader ? parseInt(String(contentLengthHeader)) : 0; } catch { reportedLength = 0; }
                            const hasBody = (typeof body === 'string' && body.length > 0) || reportedLength > 0;
                            if (!hasBody) {
                                log.debug(`[preNav] empty body, skip capture key=${cfg.key} url=${url}`);
                                continue;
                            }

                            // Cookies snapshot (raw from engine, no normalization for now)
                            let cookiesRaw: any[] = [];
                            try {
                                const ctx = typeof page.context === 'function' ? page.context() : undefined;
                                if (ctx && typeof ctx.cookies === 'function') {
                                    cookiesRaw = await ctx.cookies(url);
                                } else if (typeof page.cookies === 'function') {
                                    cookiesRaw = await page.cookies(url);
                                }
                            } catch { /* ignore */ }

                            // Raw Set-Cookie header values (no parsing)
                            const setCookieHeader = (headers as any)?.['set-cookie'] ?? (lowerHeaders as any)['set-cookie'];
                            const setCookieRaw: string[] = Array.isArray(setCookieHeader)
                                ? setCookieHeader as string[]
                                : (typeof setCookieHeader === 'string' ? [setCookieHeader] : []);

                            // Method
                            let method: string | undefined = undefined;
                            try { const req = typeof response.request === 'function' ? response.request() : undefined; method = req && typeof req.method === 'function' ? req.method() : undefined; } catch { }

                            const payload = {
                                key: cfg.key,
                                url,
                                method,
                                status,
                                headers: lowerHeaders,
                                body,
                                matchedAt: Date.now(),
                                cookiesRaw,
                                setCookieRaw,
                            };

                            const ns = `${jobId}:${requestId}:${cfg.key}`;
                            const dataKey = `prenav:data:${ns}`;
                            const sigKey = `prenav:sig:${ns}`;
                            try {
                                const payloadStr = JSON.stringify(payload);
                                log.debug(`[preNav] storing payload for key=${cfg.key}, dataKey=${dataKey}, payload size=${payloadStr.length}, keys=${Object.keys(payload).join(',')}`);
                                log.debug(`[preNav] payload preview: ${payloadStr.substring(0, 300)}`);
                                const res = await (redis as any).set(dataKey, payloadStr, 'EX', 1800);
                                log.debug(`[preNav] redis.set result=${res} for dataKey=${dataKey}`);
                                if (res === 'OK') {
                                    log.debug(`[preNav] redis.lpush sigKey=${sigKey}`);
                                    await (redis as any).lpush(sigKey, '1');
                                    log.info(`[preNav] ✓ Successfully captured and stored data for key=${cfg.key}, url=${url}`);
                                } else {
                                    log.warning(`[preNav] redis.set returned ${res} instead of OK for key=${cfg.key}`);
                                }
                            } catch (e) {
                                log.error(`[preNav] redis error for key=${cfg.key}: ${e instanceof Error ? e.message : String(e)}`);
                            }

                            cfg.done = true;
                        }

                        // If all done, cleanup
                        if (keyCfgs.every(k => k.done)) {
                            log.debug(`[preNav] all keys satisfied, cleaning up listeners`);
                            try { page.off('response', onResponse); } catch { }
                        }
                    } catch (err) {
                        log.error(`[preNav] onResponse error: ${err instanceof Error ? err.message : String(err)}`);
                    }
                };

                page.on('response', onResponse);
                log.debug(`[preNavHook] response listener attached successfully`);
                page.once('close', () => {
                    log.debug(`[preNav] page closed, cleaning up listeners`);
                    try { page.off('response', onResponse); } catch { }
                });
            } catch (err) {
                log.error(`[preNavHook] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
                log.error(`[preNavHook] stack: ${err instanceof Error ? err.stack : 'N/A'}`);
            }
        };

        // Add browser-specific hooks to preNavigationHooks
        const existingHooks = options.preNavigationHooks || [];
        options.preNavigationHooks = [viewportHook, bandwidthHook, adBlockingHook, requestTimeoutHook, authenticationHook, cloudflareSolverHook, preNavHook, ...existingHooks];

        log.info(`[EngineConfigurator] Browser-specific hooks configured for ${engineType}: total=${options.preNavigationHooks.length}, hooks=[viewport, bandwidth, adBlocking, requestTimeout, authentication, cloudflareSolver, preNav], existingHooks=${existingHooks.length}`);

        // Post-navigation hook for Cloudflare Turnstile - wait for solve completion
        const cloudflareSolverPostHook = async ({ page, response, request }: any) => {
            try {
                // Check if captcha solving is enabled for this page
                if (!(page as any).__captchaSolverEnabled) {
                    return;
                }

                // Check response status
                let statusCode = 0;
                try {
                    statusCode = typeof response?.status === 'function' ? response.status() : (response?.status || 0);
                } catch { }

                // Check HTML for Cloudflare challenge characteristics
                const challengeInfo = await page.evaluate(() => {
                    const html = document.documentElement.outerHTML;
                    const title = document.title || '';

                    const isCloudflareChallenge =
                        title.includes('Just a moment') ||
                        title.includes('Checking your browser') ||
                        title.includes('Please wait') ||
                        html.includes('cf-turnstile') ||
                        html.includes('challenge-platform') ||
                        html.includes('challenge-running') ||
                        html.includes('challenge-stage') ||
                        html.includes('cf-chl-widget') ||
                        html.includes('challenges.cloudflare.com');

                    return { isCloudflareChallenge, title };
                }).catch(() => ({ isCloudflareChallenge: false, title: '' }));

                if (!challengeInfo.isCloudflareChallenge) {
                    log.debug('[CloudflareSolverPostHook] Not a Cloudflare challenge page, skipping');
                    return;
                }

                log.info(`[CloudflareSolverPostHook] Cloudflare challenge detected (title: "${challengeInfo.title}", status: ${statusCode})`);

                // Check if our script intercepted render (check for proxy or polling interception)
                const intercepted = await page.evaluate(() => {
                    return (window as any).__turnstileSolving ||
                           (window as any).__turnstileSolved ||
                           (window as any).__turnstileReady ||  // Proxy script is ready
                           typeof (window as any).cfCallback === 'function';
                }).catch(() => false);

                if (intercepted) {
                    log.info('[CloudflareSolverPostHook] Render intercepted by proxy/polling script, waiting for solve...');
                } else {
                    // Render not intercepted - try to reload page to trigger our proxy
                    log.info('[CloudflareSolverPostHook] Render not intercepted, attempting page reload to trigger proxy...');

                    // Get navigation options from solver or use request-level config
                    const cdpSolver = (page as any).__cdpTurnstileSolver as CDPTurnstileSolver | undefined;
                    const navOptions = cdpSolver?.getNavigationOptions() || {
                        timeout: request.userData?.options?.timeout || parseInt(process.env.ANYCRAWL_NAV_TIMEOUT || '30000', 10),
                        waitUntil: request.userData?.options?.wait_until || process.env.ANYCRAWL_NAV_WAIT_UNTIL || 'domcontentloaded',
                    };

                    try {
                        // Reload the page - our addInitScript/evaluateOnNewDocument will run before CF scripts
                        await page.reload(navOptions);

                        // Check again after reload
                        const interceptedAfterReload = await page.evaluate(() => {
                            return (window as any).__turnstileSolving ||
                                   (window as any).__turnstileSolved ||
                                   (window as any).__turnstileReady ||
                                   typeof (window as any).cfCallback === 'function';
                        }).catch(() => false);

                        if (interceptedAfterReload) {
                            log.info('[CloudflareSolverPostHook] Proxy active after reload, waiting for solve...');
                        } else {
                            // Still not intercepted - use fallback extraction from _cf_chl_opt
                            log.info('[CloudflareSolverPostHook] Proxy still not active, using fallback extraction...');
                        }
                    } catch (reloadError) {
                        log.warning(`[CloudflareSolverPostHook] Reload failed: ${reloadError}`);
                    }

                    // Extract params from _cf_chl_opt
                    const extractedParams = await page.evaluate(() => {
                        const cfOpt = (window as any)._cf_chl_opt;
                        if (cfOpt && cfOpt.cTurnstileSitekey) {
                            return {
                                sitekey: cfOpt.cTurnstileSitekey,
                                pageurl: window.location.href,
                                data: cfOpt.cData,
                                pagedata: cfOpt.chlPageData,
                                action: cfOpt.chlAction || 'managed',
                            };
                        }
                        return null;
                    }).catch(() => null);

                    if (extractedParams && extractedParams.sitekey) {
                        log.info(`[CloudflareSolverPostHook] Extracted sitekey: ${extractedParams.sitekey.substring(0, 20)}...`);

                        const apiKey = (page as any).__captchaSolverApiKey;
                        const solver = new CloudflareSolver({ apiKey });

                        try {
                            log.info('[CloudflareSolverPostHook] Calling 2captcha API...');
                            const result = await solver.solveTurnstile(extractedParams);

                            if (result.success && result.token) {
                                log.info('[CloudflareSolverPostHook] Solved! Injecting token...');

                                // For Cloudflare challenge pages, we need to call the turnstile callback
                                // The callback is stored when turnstile.render() is called
                                const injected = await page.evaluate((token: string) => {
                                    // Method 1: Try turnstile.getResponse to find the widget and callback
                                    if ((window as any).turnstile) {
                                        // Find all turnstile containers
                                        const containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
                                        for (const container of containers) {
                                            // Try to get widget ID
                                            const widgetId = container.querySelector('iframe')?.getAttribute('id')?.replace('cf-chl-widget-', '');
                                            if (widgetId) {
                                                try {
                                                    // Cloudflare stores callbacks internally
                                                    // We can try to trigger success by calling the internal callback
                                                    const turnstile = (window as any).turnstile;
                                                    if (turnstile._callbacks && turnstile._callbacks[widgetId]) {
                                                        turnstile._callbacks[widgetId](token);
                                                        return 'turnstile-callback';
                                                    }
                                                } catch {}
                                            }
                                        }
                                    }

                                    // Method 2: Find and fill the hidden input, then submit
                                    const inputs = [
                                        document.querySelector('input[name="cf-turnstile-response"]'),
                                        document.querySelector('textarea[name="cf-turnstile-response"]'),
                                        document.querySelector('input[name="g-recaptcha-response"]'),
                                        document.querySelector('textarea[name="g-recaptcha-response"]'),
                                    ].filter(Boolean);

                                    for (const input of inputs) {
                                        if (input) {
                                            (input as HTMLInputElement).value = token;
                                        }
                                    }

                                    // Find challenge form and submit
                                    const form = document.querySelector('form#challenge-form') ||
                                        document.querySelector('form[action*="challenge"]') ||
                                        document.querySelector('form');

                                    if (form && inputs.length > 0) {
                                        (form as HTMLFormElement).submit();
                                        return 'form-submit';
                                    }

                                    // Method 3: Try _cf_chl_opt callback
                                    const cfOpt = (window as any)._cf_chl_opt;
                                    if (cfOpt) {
                                        // Try various callback names
                                        const callbackNames = [
                                            cfOpt.chlCallback,
                                            cfOpt.onSuccess,
                                            'tsCallback',
                                            'onTurnstileSuccess',
                                        ].filter(Boolean);

                                        for (const name of callbackNames) {
                                            if (typeof (window as any)[name] === 'function') {
                                                (window as any)[name](token);
                                                return 'cf-callback-' + name;
                                            }
                                        }
                                    }

                                    return 'no-method';
                                }, result.token);

                                log.info(`[CloudflareSolverPostHook] Injection result: ${injected}`);

                                if (injected !== 'no-method') {
                                    (page as any).__captchaSolved = true;
                                    // Wait for navigation using configured options
                                    try {
                                        await page.waitForNavigation(navOptions);
                                        log.info('[CloudflareSolverPostHook] Navigation completed after token injection');
                                    } catch {
                                        log.debug('[CloudflareSolverPostHook] No navigation after injection');
                                    }
                                    return;
                                } else {
                                    log.warning('[CloudflareSolverPostHook] Could not find injection method');
                                }
                            }
                        } catch (e) {
                            log.error(`[CloudflareSolverPostHook] Fallback solve failed: ${e}`);
                        }
                    } else {
                        log.warning('[CloudflareSolverPostHook] Could not extract params from _cf_chl_opt');
                    }
                }

                // IMPORTANT: Wait for Turnstile to load and be intercepted by console listener
                // The console listener will start solving automatically when it intercepts params
                log.info('[CloudflareSolverPostHook] Waiting for Turnstile to load and be solved...');

                const maxWaitTime = 120000; // 2 minutes max wait
                const waitStart = Date.now();

                while (Date.now() - waitStart < maxWaitTime) {
                    // Check if CDPTurnstileSolver already solved it
                    const cdpSolver = (page as any).__cdpTurnstileSolver as CDPTurnstileSolver | undefined;
                    if (cdpSolver?.isSolved()) {
                        log.info('[CloudflareSolverPostHook] CDPTurnstileSolver reports solved, done!');
                        return;
                    }

                    // Check if already solved - navigation was already handled in the pre-nav hook
                    if ((page as any).__captchaSolved) {
                        log.info('[CloudflareSolverPostHook] Captcha was already solved in pre-nav hook, continuing...');
                        return;
                    }

                    // Check page state - if solved or no longer on challenge page
                    const pageState = await page.evaluate(() => {
                        const title = document.title || '';
                        return {
                            solved: (window as any).__turnstileSolved,
                            solving: (window as any).__turnstileSolving,
                            isChallengePage: title.includes('Just a moment') || title.includes('Checking') || title.includes('Please wait'),
                            title,
                        };
                    }).catch(() => ({ solved: false, solving: false, isChallengePage: true, title: '' }));

                    if (pageState.solved) {
                        log.info('[CloudflareSolverPostHook] Page reports __turnstileSolved=true, done!');
                        return;
                    }

                    // If no longer on challenge page, we're done
                    if (!pageState.isChallengePage) {
                        log.info(`[CloudflareSolverPostHook] No longer on challenge page (title: "${pageState.title}"), done!`);
                        return;
                    }

                    // Check if solving is in progress - wait for it
                    if (pageState.solving || cdpSolver?.isSolving()) {
                        log.debug('[CloudflareSolverPostHook] Captcha solving in progress, waiting...');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }

                    // Check if params were intercepted but solving hasn't started yet
                    if ((page as any).__interceptedParams) {
                        log.debug('[CloudflareSolverPostHook] Params intercepted, waiting for solve to start...');
                        await new Promise(resolve => setTimeout(resolve, 500));
                        continue;
                    }

                    // Try to extract params from page if console listener hasn't intercepted them
                    const extractedParams = await page.evaluate(() => {
                        // Method 1: From window._cf_chl_opt (Cloudflare challenge options - most reliable)
                        const cfOpt = (window as any)._cf_chl_opt;
                        if (cfOpt && cfOpt.cTurnstileSitekey) {
                            return {
                                sitekey: cfOpt.cTurnstileSitekey,
                                pageurl: window.location.href,
                                data: cfOpt.cData,
                                pagedata: cfOpt.chlPageData,
                                action: cfOpt.chlAction || 'managed',
                            };
                        }

                        // Method 2: From data-sitekey attribute
                        const turnstileEl = document.querySelector('[data-sitekey]');
                        if (turnstileEl) {
                            const sitekey = turnstileEl.getAttribute('data-sitekey');
                            if (sitekey) {
                                return {
                                    sitekey,
                                    pageurl: window.location.href,
                                };
                            }
                        }

                        return null;
                    }).catch(() => null);

                    if (extractedParams && extractedParams.sitekey) {
                        // We found params but console listener didn't intercept them
                        // This means Turnstile loaded but our inject script didn't catch it
                        // Start solving manually
                        log.info(`[CloudflareSolverPostHook] Extracted params from page: sitekey=${extractedParams.sitekey}`);

                        const apiKey = (page as any).__captchaSolverApiKey;
                        const solver = new CloudflareSolver({ apiKey });

                        (page as any).__captchaSolving = true;
                        try {
                            log.info('[CloudflareSolverPostHook] Solving Turnstile challenge...');
                            const result = await solver.solveTurnstile(extractedParams);

                            if (result.success && result.token) {
                                log.info('[CloudflareSolverPostHook] Turnstile solved, injecting token...');

                                const injected = await page.evaluate((token: string) => {
                                    if (typeof (window as any).cfCallback === 'function') {
                                        console.log('[CloudflareSolver] Executing cfCallback with token');
                                        (window as any).cfCallback(token);
                                        return 'cfCallback';
                                    }

                                    const form = document.querySelector('form[action*="challenge"]') ||
                                        document.querySelector('form#challenge-form') ||
                                        document.querySelector('form');

                                    const responseInput = document.querySelector('input[name="cf-turnstile-response"]') ||
                                        document.querySelector('textarea[name="cf-turnstile-response"]') ||
                                        document.querySelector('input[name="g-recaptcha-response"]') ||
                                        document.querySelector('textarea[name="g-recaptcha-response"]');

                                    if (responseInput) {
                                        (responseInput as HTMLInputElement).value = token;
                                        if (form) {
                                            (form as HTMLFormElement).submit();
                                            return 'form-submit';
                                        }
                                        return 'input-only';
                                    }

                                    return null;
                                }, result.token);

                                if (injected) {
                                    log.info(`[CloudflareSolverPostHook] Token injected via: ${injected}`);
                                    (page as any).__captchaSolved = true;

                                    // Get navigation options from solver or use request-level config
                                    const cdpSolverForNav = (page as any).__cdpTurnstileSolver as CDPTurnstileSolver | undefined;
                                    const navOptionsForWait = cdpSolverForNav?.getNavigationOptions() || {
                                        timeout: request.userData?.options?.timeout || parseInt(process.env.ANYCRAWL_NAV_TIMEOUT || '30000', 10),
                                        waitUntil: request.userData?.options?.wait_until || process.env.ANYCRAWL_NAV_WAIT_UNTIL || 'domcontentloaded',
                                    };

                                    await page.waitForNavigation(navOptionsForWait).catch(() => {
                                        log.debug('[CloudflareSolverPostHook] No navigation after token injection');
                                    });

                                    log.info('[CloudflareSolverPostHook] Cloudflare challenge solved successfully');
                                    return;
                                } else {
                                    log.warning('[CloudflareSolverPostHook] Could not find element to inject token');
                                }
                            } else {
                                log.error(`[CloudflareSolverPostHook] Failed to solve Turnstile: ${result.error}`);
                            }
                        } finally {
                            (page as any).__captchaSolving = false;
                        }
                        return;
                    }

                    // Wait a bit before checking again
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

                log.warning('[CloudflareSolverPostHook] Timeout waiting for Turnstile to load/solve');

                // Clean up console handler
                try {
                    const handler = (page as any).__captchaConsoleHandler;
                    if (handler) {
                        page.off('console', handler);
                    }
                } catch { }

            } catch (error) {
                log.error(`[CloudflareSolverPostHook] Error: ${error instanceof Error ? error.message : String(error)}`);
            }
        };

        // Add post-navigation hooks
        const existingPostHooks = options.postNavigationHooks || [];
        options.postNavigationHooks = [cloudflareSolverPostHook, ...existingPostHooks];

        log.info(`[EngineConfigurator] Post-navigation hooks configured for ${engineType}: total=${options.postNavigationHooks.length}`);

        // Apply headless configuration from environment
        if (options.headless === undefined) {
            options.headless = process.env.ANYCRAWL_HEADLESS !== "false";
        }

        // Configure retry behavior - disable automatic retries for blocked pages
        options.retryOnBlocked = true;

        options.maxRequestRetries = 3;
        options.maxSessionRotations = 3; // Enable session rotation

        // Check if captcha solving is enabled
        const captchaSolverEnabled = !!(process.env.CAPTCHA_SOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY);

        // Configure session pool with specific settings
        if (options.useSessionPool !== false) {
            options.sessionPoolOptions = {
                ...options.sessionPoolOptions,
                // When captcha solver is enabled, don't treat 403 as blocked
                // This allows the post-navigation hook to handle Cloudflare challenges
                blockedStatusCodes: captchaSolverEnabled ? [401, 429, 500, 502, 503] : [],
                // Configure session options to rotate after every error
                sessionOptions: {
                    ...options.sessionPoolOptions?.sessionOptions,
                    maxErrorScore: 1, // Rotate sessions after every error
                },
            };


        }
        // Configure how errors are evaluated
        options.errorHandler = async (context: any, error: Error) => {
            log.debug(`Error handler triggered: ${error.message}`);

            // Handle CrawlLimitReachedError specially - log as INFO instead of ERROR
            if (error instanceof CrawlLimitReachedError) {
                log.info(`[EXPECTED] Crawl limit reached for job ${error.jobId}: ${error.reason} - continuing with processed pages`);
                return false; // Don't retry, don't mark as failed
            }

            // Check error type and determine retry strategy
            const errorMessage = error.message || '';

            // Handle 403 errors - allow retry with session rotation (up to 3 times)
            // The refresh logic in requestHandler will attempt to recover before retry
            if (errorMessage.includes('blocked status code: 403') || errorMessage.includes('403')) {
                log.info('403 error detected, waiting 10 seconds before retry with session rotation');
                log.debug('403 error: waiting completed, allowing retry with session rotation (refresh will be attempted in requestHandler)');
                return true; // Retry with new session (up to maxSessionRotations = 3)
            }

            // Proxy-related errors that might be temporary
            const temporaryProxyErrors = [
                'ERR_PROXY_CONNECTION_FAILED',
                'ERR_TUNNEL_CONNECTION_FAILED',
                'ERR_PROXY_AUTH_FAILED',
                'ERR_NEED_TO_RETRY',
                'ERR_SOCKS_CONNECTION_FAILED'
            ];

            if (temporaryProxyErrors.some(err => errorMessage.includes(err))) {
                log.debug('Temporary proxy error detected, allowing retry with session rotation');
                return true; // Retry with new session
            }

            // For all other errors, don't retry
            log.debug('Unknown error type, not retrying');
            return false;
        };
    }

    private static configurePuppeteer(options: any): void {
        // Puppeteer-specific configurations can be added here
        options.browserPoolOptions = {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{ name: BrowserName.chrome, minVersion: 120 }],
                },
            },
        };
    }

    private static configurePlaywright(options: any): void {
        // Playwright-specific configurations can be added here
        options.browserPoolOptions = {
            useFingerprints: true,
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: [{ name: BrowserName.chrome, minVersion: 120 }],
                },
            },
        };
    }

    private static configureCheerio(options: any): void {
        // Cheerio-specific configurations can be added here
    }
}
