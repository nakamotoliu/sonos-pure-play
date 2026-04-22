# Sonos auth and recovery

## Credential source rule
- Always fetch Sonos Web credentials from the operator's password manager first.
- Use `~/clawd/scripts/bw-ensure-unlocked.sh` to obtain `BW_SESSION` before any `bw` call.
- Never commit Sonos credentials into the skill.
- Do not require a local credential file for normal recovery; the tracked skill should document the interaction pattern, not store secrets.

## Current runtime expectation
- Normal fast path still prefers an already-logged-in Sonos Web session in the selected browser profile.
- If Sonos Web is logged out, the skill should try a controlled login recovery instead of failing immediately.
- Login recovery must stop if the password manager does not contain a usable Sonos item or if an extra challenge/OTP appears.

## Recovery workflow
1. Confirm the selected browser runtime profile is the intended one for the run.
2. Navigate to Sonos Web and inspect whether the page is blocked by login.
3. If blocked by login, use this exact visible-form recovery pattern:
   - page cue: URL is usually `https://login.sonos.com/`
   - login-form cue: the page contains an email textbox labeled `电子邮件` or `Email`, a password textbox labeled `密码` or `Password`, and a `登录` / `Sign in` button
   - input order: fill the email/account field first, then fill the password field
   - success cue before submit: the `登录` button becomes enabled
   - submit step: click `登录` / `Sign in`
   - post-submit cue: if the flow redirects to a welcome page (for example `https://idassets.sonos.com/welcome`) and shows a `继续` / `Continue` button, click that button once
4. Re-check page state:
   - if search/home is now usable, continue normal playback flow
   - if a challenge / OTP / unexpected identity provider page appears, stop and report the block clearly
5. Never write credentials to tracked files, logs, or wiki.

## Agent-operable field map
- Account/email input:
  - find textbox by visible label text matching `电子邮件` or `Email`
  - this is where the Sonos account email should be entered
- Password input:
  - find textbox by visible label text matching `密码` or `Password`
  - this is where the Sonos password should be entered
- Submit button:
  - find button text matching `登录` or `Sign in`
  - do not click until both fields are filled and the button is enabled
- Welcome continuation:
  - after submit, if a page with heading like `欢迎` appears and shows a button `继续` / `Continue`, click it once to enter the logged-in Sonos page

## Input method guidance
- Prefer direct browser-tool interactions against visible labeled controls.
- First choice: click the labeled textbox, then type normally.
- If the page is flaky, refill by targeting the exact labeled textbox again rather than guessing another input.
- Do not search results or inspect candidates until the login form is cleared and Sonos search/home is visible.

## Password-manager item naming
- Prefer a clearly named Sonos login item in the operator's password manager (for example one matching `sonos`).
- The runtime should tolerate operator-specific naming by searching the password manager rather than hardcoding a single item id.

## Failure reporting
- Distinguish these cases clearly:
  - `BITWARDEN_ITEM_NOT_FOUND`
  - `LOGIN_FORM_NOT_FOUND`
  - `LOGIN_SUBMIT_FAILED`
  - `LOGIN_CHALLENGE_REQUIRED`
- A missing login session is recoverable only when password-manager lookup and the visible login form both succeed.
