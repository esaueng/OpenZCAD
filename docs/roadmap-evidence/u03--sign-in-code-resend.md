---
row: U03
---

13 November design review I81 and I86 (Settings): the email-code step offers
"Send a new code" after 30 s behind its own security check, its placeholder is
"6-digit code", and a refused code is cleared and refocused; AI Assistant ›
Token says "Sign-in could not be reached" with Retry, as Account does, instead
of a Sign in that led there (`SettingsPage.test.tsx`).
