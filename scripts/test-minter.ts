import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileFunc } from '@ton-community/func-js';
const TEST_PROJECT_ROOT = process.env.TONOFCOV_TEST_PROJECT ?? './test-project';
async function main() {
    console.log('Compiling JettonMinter with debugInfo: true');
    const cr = await compileFunc({
        targets: ['contracts/jetton-minter.fc'],
        sources: (p: string) => readFileSync(join(TEST_PROJECT_ROOT, p), 'utf8'),
        debugInfo: true,
    });
    if (cr.status === 'error') throw new Error(cr.message);
    console.log('OK. locations:', cr.debugInfo?.locations.length);
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
