---
row: L11
---
Encrypted share-link creation now requires the owner's sharing confirmation.
The sharing dialog refuses to present a newly created URL while its authority
or model publication remains pending, and disables copying inactive links.
Regression coverage checks confirmation before creation, pending publication,
and copying states; the real owner/visitor browser journeys exercise
confirmation followed by an anonymously verified, decrypted model.
Preview deployment and the reported live link's stored state remain unverified.
