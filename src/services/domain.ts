import dns from 'dns';
import { logger } from '../logger.js';

export class DomainService {
    async isAvailable(domain: string): Promise<boolean> {
        return new Promise((resolve) => {
            dns.resolve(domain, (err) => {
                if (err && err.code === 'ENOTFOUND') {
                    // ENOTFOUND means the domain is NOT resolving, so it MIGHT be available.
                    // This is a naive check (WHOIS is more accurate but complex/paid).
                    logger.debug({ domain }, 'Domain lookup failed with ENOTFOUND - might be available');
                    resolve(true);
                } else {
                    // If no error or other error, assume it is registered or has some records.
                    logger.debug({ domain, err_code: err?.code }, 'Domain lookup returned records or other error - likely taken');
                    resolve(false);
                }
            });
        });
    }
}
