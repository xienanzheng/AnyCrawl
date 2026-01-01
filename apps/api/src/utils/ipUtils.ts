import { Request } from "express";

/**
 * Get client IP address from request, considering proxy headers
 * Priority order:
 * 1. CF-Connecting-IP (Cloudflare)
 * 2. X-Forwarded-For (general proxy header)
 * 3. X-Real-IP (some proxies like Nginx)
 * 4. req.ip (Express trust proxy)
 * @param req Express request object
 * @returns Client IP address or null if not found
 */
export function getClientIp(req: Request): string | null {
    // Check CF-Connecting-IP header (Cloudflare's header for real client IP)
    const cfConnectingIp = req.headers["cf-connecting-ip"];
    if (cfConnectingIp) {
        const ip = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
        if (ip) {
            return ip.trim();
        }
    }

    // Check X-Forwarded-For header (first IP in chain is the original client)
    const forwardedFor = req.headers["x-forwarded-for"];
    if (forwardedFor) {
        const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        if (ips) {
            // X-Forwarded-For can contain multiple IPs, take the first one
            const firstIp = ips.split(",")[0]?.trim();
            if (firstIp) {
                return firstIp;
            }
        }
    }

    // Check X-Real-IP header (set by some proxies)
    const realIp = req.headers["x-real-ip"];
    if (realIp) {
        const ip = Array.isArray(realIp) ? realIp[0] : realIp;
        if (ip) {
            return ip.trim();
        }
    }

    // Fallback to req.ip (set by Express trust proxy)
    return req.ip || null;
}

/**
 * Check if an IP address matches any pattern in the whitelist
 * Supports:
 * - Exact IP match: "192.168.1.1"
 * - CIDR notation: "192.168.1.0/24"
 * @param ip IP address to check
 * @param whitelist Array of IP addresses or CIDR ranges
 * @returns true if IP matches any pattern in whitelist
 */
export function isIpAllowed(ip: string | null, whitelist: string[] | null | undefined): boolean {
    // If no whitelist is set, allow all IPs
    if (!whitelist || whitelist.length === 0) {
        return true;
    }

    // If IP is not available, deny access
    if (!ip) {
        return false;
    }

    // Check each pattern in whitelist
    for (const pattern of whitelist) {
        if (matchesIpPattern(ip, pattern)) {
            return true;
        }
    }

    return false;
}

/**
 * Check if an IP address matches a pattern (exact match or CIDR)
 * @param ip IP address to check
 * @param pattern IP address or CIDR range
 * @returns true if IP matches the pattern
 */
function matchesIpPattern(ip: string, pattern: string): boolean {
    // Exact match
    if (ip === pattern) {
        return true;
    }

    // CIDR notation check
    if (pattern.includes("/")) {
        return matchesCidr(ip, pattern);
    }

    return false;
}

/**
 * Check if an IP address is within a CIDR range
 * @param ip IP address to check
 * @param cidr CIDR notation (e.g., "192.168.1.0/24")
 * @returns true if IP is within the CIDR range
 */
function matchesCidr(ip: string, cidr: string): boolean {
    try {
        const parts = cidr.split("/");
        const network = parts[0];
        const prefixLengthStr = parts[1];

        if (!network || !prefixLengthStr) {
            return false;
        }

        const prefixLength = parseInt(prefixLengthStr, 10);

        if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 128) {
            return false;
        }

        // Convert IP to number for comparison
        const ipNum = ipToNumber(ip);
        const networkNum = ipToNumber(network);

        if (ipNum === null || networkNum === null) {
            return false;
        }

        // Calculate subnet mask
        // For IPv4, mask should have first prefixLength bits set to 1
        // Example: /24 means first 24 bits are 1, last 8 bits are 0
        const hostBits = 32n - BigInt(prefixLength);
        const hostMask = 2n ** hostBits - 1n; // Mask for host bits (e.g., 0xFF for /24)
        const subnetMask = (2n ** 32n - 1n) - hostMask; // Mask for network bits (e.g., 0xFFFFFF00 for /24)

        // Check if IP is in the same subnet
        return (ipNum & subnetMask) === (networkNum & subnetMask);
    } catch {
        return false;
    }
}

/**
 * Convert IP address to BigInt for comparison
 * Supports IPv4 only
 * @param ip IP address string
 * @returns BigInt representation or null if invalid
 */
function ipToNumber(ip: string): bigint | null {
    const parts = ip.split(".");
    if (parts.length !== 4) {
        return null;
    }

    try {
        let num = 0n;
        for (let i = 0; i < 4; i++) {
            const partStr = parts[i];
            if (!partStr) {
                return null;
            }
            const part = parseInt(partStr, 10);
            if (isNaN(part) || part < 0 || part > 255) {
                return null;
            }
            num = (num << 8n) | BigInt(part);
        }
        return num;
    } catch {
        return null;
    }
}

