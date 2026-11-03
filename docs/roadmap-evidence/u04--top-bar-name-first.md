---
row: U04
---

Top islands, name first: the identity island no longer squeezes the project
name to nothing between 621 and 1280px. The bar now drops things in one fixed
order, never adding anything back as the window narrows. Below 1200px the
wordmark and the "Saved" word go. Below 960px the mode and action labels go
together. Below 760px the mode switch joins the actions on the right. Below
480px the bar takes two rows. Above 1200px a name that would be cut drops the
wordmark instead. The mode switch's segments fit their own labels (384px, down
from 486px), with a measured sliding thumb. Evidence: `settings.spec.ts`
(collapse at 959px, a phone-width name shown in full) and
`encrypted-projects.spec.ts` (lock beside the name on a phone, a full name at
1366px with the lock).
