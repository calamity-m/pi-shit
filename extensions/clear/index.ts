import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function clearExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a fresh session and clear the visible conversation",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const result = await ctx.newSession();
			if (result.cancelled) {
				ctx.ui.notify("Clear cancelled", "info");
			}
		},
	});
}
