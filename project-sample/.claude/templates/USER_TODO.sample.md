# USER_TODO — User requests

> One request per row with an **ID `REQ-{groupid:0000}-{reqid:0000}`**. The cycle analyses a request into
> `AI_TODO.md` tasks **only after the row is approved**. Approver/date and writer/date live in the JSON
> sidecars (ADR-0320), not here; the web grid shows them.

| ID | Group | Depends | Request |
|----|-------|---------|---------|
| REQ-0001-0001 | Auth | | Add a login screen with email + password, validating inputs and showing errors |
| REQ-0001-0002 | Auth | REQ-0001-0001 | Wire it to the existing auth API and handle the error responses |
