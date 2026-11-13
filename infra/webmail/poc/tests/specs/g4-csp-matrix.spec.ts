import { writeFileSync } from 'node:fs';
import { test, expect, type Frame, type Page } from '@playwright/test';
import { APEX, collectCspViolations, cspViolations, openWebmail, resetBridge, WEBMAIL_ORIGIN } from '../lib/poc';
import { seedAlice } from '../lib/seed.mjs';

const BASE = (script: string, style: string) =>
    `default-src 'self'; script-src ${script}; style-src ${style}; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://${APEX}`;

const VARIANTS = {
    shipped: BASE("'self' 'unsafe-inline' 'unsafe-eval'", "'self' 'unsafe-inline'"),
    noUnsafeEval: BASE("'self' 'unsafe-inline'", "'self' 'unsafe-inline'"),
    noUnsafeInlineScript: BASE("'self' 'unsafe-eval'", "'self' 'unsafe-inline'"),
    noUnsafeInlineStyle: BASE("'self' 'unsafe-inline' 'unsafe-eval'", "'self'"),
};

/**
 * Experiment only: runs the "this.method(json);" lines of response.exec without eval.
 * Shows what it would take to drop 'unsafe-eval'.
 */
function installExecInterpreter() {
    let client: any;
    Object.defineProperty(window, 'rcmail', {
        configurable: true,
        get: () => client,
        set: (value) => {
            client = value;
            value.addEventListener('responsebefore', ({ response }: any) => {
                const lines = String(response.exec ?? '').split('\n').filter(Boolean);
                response.exec = '';
                for (const line of lines) {
                    const match = /^this\.([\w.]+)\((.*)\);$/s.exec(line);
                    if (!match) {
                        console.log(`SHIM-UNPARSED ${line.slice(0, 120)}`);
                        continue;
                    }
                    const path = match[1].split('.');
                    const method = path.pop() as string;
                    let target = value;
                    for (const part of path) target = target[part];
                    target[method](...JSON.parse(`[${match[2]}]`));
                }
            });
        },
    });
}

async function probe(page: Page, frame: Frame, policy: string) {
    await page.context().route(new RegExp(`^${WEBMAIL_ORIGIN}/`), async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        await route.fulfill({
            response,
            headers: { ...response.headers(), 'content-security-policy': policy },
        });
    });

    await frame.goto(`${WEBMAIL_ORIGIN}/?_task=mail&_mbox=INBOX`);
    await page.waitForTimeout(4000);

    const violations = await cspViolations(frame);
    const rows = await frame.evaluate(() => {
        const list = (window as any).rcmail?.message_list;
        return list ? Object.keys(list.rows).length : -1;
    }).catch(() => -2);

    return {
        messageListRows: rows,
        violations: violations.length,
        directives: [...new Set(violations.map((entry: any) => entry.directive))],
    };
}

test.describe('G4 CSP requirements', () => {
    for (const [name, policy] of Object.entries(VARIANTS)) {
        test(`CSP variant ${name}`, async ({ page, browserName }) => {
            await seedAlice();
            await resetBridge();
            await collectCspViolations(page);
            const frame = await openWebmail(page);

            const result = await probe(page, frame, policy);
            console.log(`CSP-MATRIX ${browserName} ${name} ${JSON.stringify(result)}`);
            writeFileSync(`/results/csp-${browserName}-${name}.json`, JSON.stringify(result));

            if (name === 'shipped') {
                expect(result.messageListRows).toBe(7);
                expect(result.violations).toBe(0);
            }
        });
    }

    test('dropping unsafe-eval needs an exec interpreter', async ({ page, browserName }) => {
        await seedAlice();
        await resetBridge();
        await collectCspViolations(page);
        await page.addInitScript(installExecInterpreter);
        page.on('console', (message) => {
            if (message.text().startsWith('SHIM-UNPARSED')) console.log(message.text());
        });
        const frame = await openWebmail(page);

        const result = await probe(page, frame, VARIANTS.noUnsafeEval);
        console.log(`CSP-MATRIX ${browserName} noUnsafeEvalWithInterpreter ${JSON.stringify(result)}`);
        writeFileSync(`/results/csp-${browserName}-noUnsafeEvalWithInterpreter.json`, JSON.stringify(result));
    });
});
