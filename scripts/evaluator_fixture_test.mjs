import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { evaluateKOC } from '../server/evaluator.js';

const gradeRank = { D: 1, C: 2, B: 3, A: 4, S: 5 };
const fixturePath = new URL('../tests/fixtures/evaluator_cases.json', import.meta.url);

function assertGradeAtLeast(actual, expected) {
    assert.ok(gradeRank[actual] >= gradeRank[expected], `grade ${actual} < ${expected}`);
}

function assertGradeAtMost(actual, expected) {
    assert.ok(gradeRank[actual] <= gradeRank[expected], `grade ${actual} > ${expected}`);
}

async function main() {
    const cases = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
    let passed = 0;

    for (const c of cases) {
        const out = evaluateKOC(c.input, c.keyword);
        const exp = c.expected || {};

        if (exp.gradeAtLeast) assertGradeAtLeast(out.grade, exp.gradeAtLeast);
        if (exp.gradeAtMost) assertGradeAtMost(out.grade, exp.gradeAtMost);
        if (typeof exp.confidenceAtLeast === 'number') {
            assert.ok(out.confidence >= exp.confidenceAtLeast, `confidence ${out.confidence} < ${exp.confidenceAtLeast}`);
        }
        if (typeof exp.confidenceAtMost === 'number') {
            assert.ok(out.confidence <= exp.confidenceAtMost, `confidence ${out.confidence} > ${exp.confidenceAtMost}`);
        }

        passed += 1;
        console.log(`PASS ${c.id} -> grade=${out.grade}, confidence=${out.confidence}`);
    }

    console.log(`\nEvaluator fixture tests passed=${passed}`);
}

main().catch((err) => {
    console.error('Evaluator fixture test failed');
    console.error(err);
    process.exit(1);
});
