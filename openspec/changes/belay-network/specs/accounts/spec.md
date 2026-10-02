## ADDED Requirements
### Requirement: Passwordless accounts
The service SHALL create or sign in an account via Apple, Google, or a 6-digit email code, without passwords.
#### Scenario: email code
- **WHEN** a user requests a code and enters it within 10 minutes
- **THEN** they receive a session; a wrong code 5 times locks that code
### Requirement: Account deletion
The service SHALL delete an account, its devices and sessions on request.
#### Scenario: delete
- **WHEN** a signed-in user deletes their account
- **THEN** every session and host credential stops working immediately
### Requirement: Secrets are hashed
The service SHALL store session and host credentials only as SHA-256 hashes.
#### Scenario: database leak
- **WHEN** the D1 database is read by an attacker
- **THEN** no usable session or host credential is exposed
