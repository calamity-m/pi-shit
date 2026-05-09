# Clear Extension

Registers `/clear` as a personal alias for starting a new Pi session.

Pi's built-in command for this is `/new`, but I am used to typing `/clear` when I want to wipe the visible conversation and start fresh. This extension keeps that muscle memory while using Pi's normal session replacement API under the hood.

Behavior:

- waits for the agent to become idle;
- starts a new session via `ctx.newSession()`;
- shows a small notification if the new-session action is cancelled.

This is intentionally a preference shim, not a replacement for Pi's session model.
