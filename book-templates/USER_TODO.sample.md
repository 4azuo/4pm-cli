# USER_TODO — User requests

> One request per row with an **ID `REQ-{groupid:000000}-{reqid:000}`** (group ids are allocated by the 4PM server). The cycle analyses a request into
> `AI_TODO.md` tasks **only after the row is approved**. Approver/date and writer/date live in the JSON
> sidecars (ADR-0320), not here; the web grid shows them.

| ID | Title | Group | Depends | Request |
|----|-------|-------|---------|---------|
| REQ-000001-001 | Login screen with email + password | Auth | | Add a login screen with email + password, validating inputs and showing errors |
| REQ-000001-002 | Login: wire to the auth API | Auth | REQ-000001-001 | Wire it to the existing auth API and handle the error responses |
