import{readdirSync,readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';import{checkRepository}from'./boundaries.mjs';
const failures=[];function scan(root){for(const entry of readdirSync(root,{withFileTypes:true})){if(['node_modules','.next','generated','design'].includes(entry.name))continue;const p=join(root,entry.name);if(entry.isDirectory())scan(p);else if(/\.(ts|tsx|js|mjs)$/.test(p)){const t=readFileSync(p,'utf8');if(/eval\s*\(/.test(t))failures.push(p+': eval');if(/dangerouslySetInnerHTML/.test(t))failures.push(p+': unsafe HTML')}}}for(const p of['apps','packages'])scan(p);if(failures.length){console.error(failures.join('\n'));process.exit(1)}console.log('Source guard checks passed');

// Import boundaries (scripts/boundaries.mjs): only violations missing from the
// baseline fail; resolved ones are reported so the baseline can shrink.
const boundaries = checkRepository(process.cwd());
if (process.argv.includes('--update-boundaries')) {
  const file = 'scripts/boundaries.json';
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.baseline = boundaries.violations;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`Boundary baseline written: ${boundaries.violations.length} known violations`);
  process.exit(0);
}
if (process.argv.includes('--boundary-report')) {
  console.log('Zone edges (imports between zones):');
  for (const [edge, count] of boundaries.edges) console.log(`  ${edge}: ${count}`);
  const byRule = {};
  for (const v of boundaries.violations) byRule[v.split(':')[0]] = (byRule[v.split(':')[0]] ?? 0) + 1;
  console.log('Violations by rule:');
  for (const [rule, count] of Object.entries(byRule).sort()) console.log(`  ${rule}: ${count}`);
}
const problems = [];
if (boundaries.unclassified.length)
  problems.push('Files without a boundary zone (add them to scripts/boundaries.json):\n  ' + boundaries.unclassified.join('\n  '));
if (boundaries.unresolved.length)
  problems.push('Internal imports the boundary check cannot resolve (extend resolveImport in scripts/boundaries.mjs):\n  ' + boundaries.unresolved.join('\n  '));
if (boundaries.added.length)
  problems.push('New import-boundary violations (see plans/orbit-modularization/02-target-architecture.md §3):\n  ' + boundaries.added.join('\n  '));
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
if (boundaries.resolved.length)
  console.warn(`Resolved boundary violations still in the baseline; run \`node scripts/source-check.mjs --update-boundaries\`:\n  ${boundaries.resolved.join('\n  ')}`);
console.log(`Import boundaries: ${boundaries.violations.length} known violations, none new`);
