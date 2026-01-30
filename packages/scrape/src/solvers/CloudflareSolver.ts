/**
 * Cloudflare Turnstile Solver
 * Uses 2captcha service to solve Cloudflare Turnstile challenges
 * Based on: https://2captcha.com/api-docs/cloudflare-turnstile
 *
 * Two cases:
 * 1. Standalone Captcha - token goes to cf-turnstile-response or g-recaptcha-response textarea
 * 2. Cloudflare Challenge page - requires cData, chlPageData, action params and callback execution
 */

import { Solver } from '@2captcha/captcha-solver';
import { log } from '@anycrawl/libs';

export interface TurnstileParams {
    sitekey: string;
    pageurl: string;
    data?: string;
    pagedata?: string;
    action?: string;
    userAgent?: string;
    isChallengePage?: boolean;
}

export interface CloudflareSolverOptions {
    apiKey: string;
    maxWaitTime?: number;
    solveTimeout?: number;
}

export interface SolveResult {
    success: boolean;
    token?: string;
    userAgent?: string;
    error?: string;
    isChallengePage?: boolean;
}

/**
 * CloudflareSolver handles Cloudflare Turnstile challenge solving
 */
export class CloudflareSolver {
    private solver: Solver;
    private maxWaitTime: number;
    private solveTimeout: number;

    constructor(options: CloudflareSolverOptions) {
        if (!options.apiKey) {
            throw new Error('2captcha API key is required');
        }
        this.solver = new Solver(options.apiKey);
        this.maxWaitTime = options.maxWaitTime ?? 30000;
        this.solveTimeout = options.solveTimeout ?? 120000;
    }

    /**
     * Solve a Turnstile challenge with the given parameters
     */
    async solveTurnstile(params: TurnstileParams): Promise<SolveResult> {
        try {
            const isChallengePage = params.isChallengePage ||
                !!(params.pagedata && params.pagedata.length > 0);

            log.info(`[CloudflareSolver] Solving Turnstile challenge for ${params.pageurl}`);
            log.info(`[CloudflareSolver] Mode: ${isChallengePage ? 'Challenge Page' : 'Standalone'}`);

            const solverParams: any = {
                sitekey: params.sitekey,
                pageurl: params.pageurl,
            };

            if (isChallengePage) {
                if (params.data) solverParams.data = params.data;
                if (params.pagedata) solverParams.pagedata = params.pagedata;
                if (params.action) solverParams.action = params.action;
            }

            const result = await this.solver.cloudflareTurnstile(solverParams);

            log.info(`[CloudflareSolver] Turnstile solved successfully, id=${result.id}`);

            const responseUserAgent = (result as any).userAgent || (result as any).useragent;

            return {
                success: true,
                token: result.data,
                userAgent: responseUserAgent,
                isChallengePage,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`[CloudflareSolver] Failed to solve Turnstile: ${errorMessage}`);

            return {
                success: false,
                error: errorMessage,
            };
        }
    }
}

/**
 * Create a CloudflareSolver instance from environment variables
 */
export function createSolverFromEnv(): CloudflareSolver | null {
    const apiKey = process.env.CAPTCHA_SOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY;

    if (!apiKey) {
        log.debug('[CloudflareSolver] No API key found in environment variables');
        return null;
    }

    return new CloudflareSolver({
        apiKey,
        maxWaitTime: process.env.CAPTCHA_MAX_WAIT_TIME
            ? parseInt(process.env.CAPTCHA_MAX_WAIT_TIME)
            : undefined,
        solveTimeout: process.env.CAPTCHA_SOLVE_TIMEOUT
            ? parseInt(process.env.CAPTCHA_SOLVE_TIMEOUT)
            : undefined,
    });
}

export default CloudflareSolver;
