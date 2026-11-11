import { randomBytes } from 'crypto';

/** Escape text for safe inclusion in HTML element content or quoted attributes. */
export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Random nonce for Content-Security-Policy script/style tags. */
export function makeNonce(length = 32): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[bytes[i] % chars.length];
    }
    return out;
}
