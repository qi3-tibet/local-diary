# Startup Draft Navigation

## Purpose

Keep the diary timeline as the application landing page while retaining the existing locally persisted draft for later continuation.

## Behavior

- On startup, the application fetches the existing draft but remains on the diary view whether or not a draft exists.
- Selecting `NEW ENTRY` opens the editor. If a draft exists, the editor receives and displays that draft.
- Saving, cancelling, publishing, and the single-draft database rule remain unchanged.

## Implementation

Remove the startup effect that switches the application view to the editor after a successful draft query. Keep the draft query in place because `Editor` already consumes it when the editor is opened.

## Verification

Add a navigation test that supplies an existing draft at startup and verifies that the diary timeline is shown. Existing editor-navigation coverage continues to verify that `NEW ENTRY` opens the editor.
