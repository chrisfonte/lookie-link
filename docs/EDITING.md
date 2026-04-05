# Editable Mode

Editing is disabled by default.

Enable it with config:

```yaml
server:
  enableEditing: true
```

Or with env:

```bash
LOOKIE_LINK_ENABLE_EDITING=true npm start
```

## Supported Files

Any non-binary file can be edited when editing mode is enabled. Binary files (executables, compressed archives, etc.) and directories are not editable. Images are view-only.

## Safety Behaviors

- Path resolution for writes uses `safeResolve()` against configured repo roots
- Stale-write guard via `expectedMtimeMs` returns `409 Conflict` if file changed on disk
- Saves use a temp file + rename pattern to reduce partial-write risk

## Security

Editable mode increases risk because the server can mutate files. Keep editing disabled unless you are on a trusted private network and intentionally want write access.
