import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function personalExtension(pi: ExtensionAPI) {
	pi.registerCommand("pi-shit", {
		description: "Confirm the personal pi package is loaded",
		handler: async (_args, ctx) => {
			ctx.ui.notify("pi-shit loaded", "success");
		},
	});
}
