# Roles and Permissions

## Default-Rollen

- anonymous
- authenticated_user
- team_member
- team_admin
- owner
- support_admin
- system

Passe diese Rollen an dein Projekt an.

## Permission Matrix Template

| Aktion | anonymous | user | team_admin | owner | support_admin | system |
|---|---:|---:|---:|---:|---:|---:|
| Ressource lesen | no | own | team | team | limited | yes |
| Ressource erstellen | no | yes | yes | yes | no | yes |
| Ressource ändern | no | own | team | team | no | yes |
| Ressource löschen | no | own? | team? | team | no | yes |

## Pflichtfragen je Feature

- Wer darf lesen?
- Wer darf erstellen?
- Wer darf ändern?
- Wer darf löschen?
- Gilt Zugriff pro User, Team, Tenant oder global?
- Gibt es Admin-Bypass?
- Ist der Check serverseitig?
- Gibt es Tests für verbotene Zugriffe?
