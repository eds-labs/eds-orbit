"""Compare generated public artifacts with local credential values without printing secrets."""
from pathlib import Path
import re
root=Path(__file__).resolve().parents[1]
secret_values=[]
env=root/'.runtime/local.env'
if env.exists():
    for line in env.read_text().splitlines():
        if '=' not in line or line.startswith('#'):continue
        key,value=line.split('=',1)
        if re.search(r'SECRET|TOKEN|PASSWORD|CREDENTIAL_KEY|API_KEY',key):
            value=value.strip().strip('\"\'')
            if len(value)>=20:secret_values.append(value.encode())
failures=[];checked=0
for folder in (root/'apps/web/.next/static',root/'docs/evidence'):
    if not folder.exists():continue
    for file in folder.rglob('*'):
        if not file.is_file() or file.suffix not in {'.js','.json','.html','.log','.md','.txt'}:continue
        checked+=1
        content=file.read_bytes()
        if any(value in content for value in secret_values):failures.append(str(file.relative_to(root)))
if failures:
    print('FAIL: local credential value found in public artifact(s): '+', '.join(failures));raise SystemExit(1)
print(f'PASS: {checked} generated artifact files compared against {len(secret_values)} local credential values; no values disclosed.')
