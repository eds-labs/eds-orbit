import { readFileSync } from 'node:fs';

const LOG_FILE = '/results/greenmail.log';

export function greenmailLog(): string[] {
    return readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n');
}

/** Lines appended to the GreenMail log since a previous snapshot. */
export function newLines(before: string[]): string[] {
    return greenmailLog().slice(before.length);
}

export function imapsConnections(lines: string[]): number {
    return lines.filter((line) => line.includes('Handling new client connection imaps:')).length;
}

export function smtpsConnections(lines: string[]): number {
    return lines.filter((line) => line.includes('Handling new client connection smtps:')).length;
}

export function imapLogins(lines: string[]): string[] {
    return lines
        .filter((line) => /C: \S+ (LOGIN|AUTHENTICATE)/.test(line))
        .map((line) => line.replace(/.*C: \S+ /, '').split(' ').slice(0, 2).join(' '));
}
