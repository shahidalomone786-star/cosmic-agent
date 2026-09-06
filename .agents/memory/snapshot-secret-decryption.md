---
name: Snapshot secret decryption
description: Capability snapshots must remain available when an existing user secret cannot be decrypted with the active key.
---

An undecryptable stored secret must not make the authenticated Control Center snapshot fail; preserve its metadata with a generic mask so the owner can rotate or delete it without exposing plaintext.

**Why:** Secret encryption keys can be rotated or become unavailable while rows remain in the database, and the snapshot aggregator needs to stay available to provide recovery controls.

**How to apply:** Keep decryption failures isolated to the affected secret row in metadata/listing paths. Never log or return the ciphertext, plaintext, or cryptographic error details to the client.