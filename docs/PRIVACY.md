# Privacy and data retention

ReviewDuck processes provider credentials, repository metadata, changed source,
review state, comments, and optional AI prompts/results to deliver the review.
It does not require AI; BYOK content is sent to the provider selected by the
workspace administrator under that provider's terms.

Source-bearing review snapshots are pruned after 30 days or when more than five
snapshots exist for a pull request, whichever boundary is reached first. An
operator can reduce both limits with `SOURCE_RETENTION_DAYS` and
`SOURCE_RETENTION_SNAPSHOTS`. Deleting an imported repository or provider
connection cascades through its pull requests, snapshots, units, comments,
AI jobs, and review sessions. Authorized users can export the retained
repository review data before deletion through the repository-data API.

Operational logs must not contain tokens, model keys, custom authorization
headers, raw provider responses, or source bodies. AI and provider failures are
normalized before storage and display. Local Docker data remains in the named
volume until the operator deletes it.

Operators accepting other users' data must publish the controller identity,
subprocessors, regional storage, contact address, and legally required
deletion/export timelines.
