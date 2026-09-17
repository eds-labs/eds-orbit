"""Scan repository candidate files without printing candidate secret values."""
import pathlib,re,subprocess,sys
patterns=[re.compile(r'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}'),re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}'),re.compile(r'\bxox[baprs]-[0-9]{9,}-[A-Za-z0-9-]{12,}'),re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')]
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0');failures=[];scanned=0
for name in files:
 p=pathlib.Path(name)
 if not name or not p.is_file() or p.stat().st_size>2_000_000:continue
 try:text=p.read_text()
 except (UnicodeError,OSError):continue
 scanned+=1
 for line_number,line in enumerate(text.splitlines(),1):
  if any(pattern.search(line) for pattern in patterns):failures.append(f'{name}:{line_number}: credential-shaped value requires review')
if failures:print('\n'.join(failures));sys.exit(1)
print(f'Secret pattern scan passed: {scanned} repository candidate text files; runtime/dependencies ignored. This is a bounded pattern scan, not proof against every secret format.')
