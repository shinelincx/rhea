import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildAcceptanceReport,
  type AcceptanceEvidence,
  type AcceptanceEvidenceKey,
} from './index.js';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const registryPath = resolve(
  repositoryRoot,
  process.argv[2] ?? 'acceptance/evidence-registry.json',
);
const outputPath = resolve(
  repositoryRoot,
  process.argv[3] ?? 'artifacts/acceptance/rhea-v1-report.json',
);
const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
  deadlines: Partial<Record<AcceptanceEvidenceKey, string>>;
  evidence: AcceptanceEvidence[];
};
const report = buildAcceptanceReport(registry.evidence, {
  deadlines: registry.deadlines,
  generatedAt: new Date().toISOString(),
});
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(
  JSON.stringify({
    event: 'acceptance_report_generated',
    conclusion: report.conclusion,
    outputPath,
  }),
);
if (!report.developmentComplete) process.exitCode = 1;
