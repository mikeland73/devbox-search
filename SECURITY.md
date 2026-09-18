# Security

The service is a read-only HTTP API over a Postgres index of nixpkgs metadata;
it stores no user data and takes no credentials from callers.

To report a vulnerability, use GitHub's private reporting on this repository
(**Security → Report a vulnerability**) rather than a public issue. You should
hear back within a few days.

In scope: the API route handlers (`apps/web`), the indexer and its GitHub
Actions workflows, and anything that could let a request read or write data it
should not. Out of scope: the contents of nixpkgs itself.
