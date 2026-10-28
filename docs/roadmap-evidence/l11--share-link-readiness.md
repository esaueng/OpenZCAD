---
row: L11
---
Encrypted share-link creation now requires the owner's sharing confirmation.
The sharing dialog refuses to present a newly created URL while its authority
or model publication remains pending, and disables copying inactive links.
Regression coverage checks confirmation before creation, pending publication,
and copying states. Publication failures retain their retry reason and are
distinguished from missing confirmation; real Worker tests verify retry without
another confirmation. The real owner/visitor browser journeys exercise
confirmation followed by an anonymously verified, decrypted model.
Read-only preview diagnosis confirmed an unrevoked link and snapshot with no
sharing authority or owner delegation. Preview deployment remains separate.
