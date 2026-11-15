/**
 * ARK image generation as a pi image runner.
 *
 * pi ships `openrouter-images`, whose request is `chat/completions` with
 * `modalities: ["image"]` and whose response is a data URL in
 * `choices[0].message.images[]`. ARK answers `POST /images/generations` with
 * `{ data: [{ b64_json }] }` instead, so the built-in runner cannot be reused.
 *
 * No host imports: this file must also parse under omp, which never calls it.
 * The contract is the documented one (docs.volcengine.com/docs/ark/
 * image-generation-api); `response_format: "b64_json"` avoids the 24-hour URL
 * expiry and produces the base64 block pi's codemode `image()` accepts.
 */

export const ARK_IMAGES_PATH = "/images/generations";

export interface ArkImageRequestOptions {
	apiKey?: string;
	signal?: AbortSignal;
	fetch?: typeof globalThis.fetch;
	headers?: Record<string, string>;
}

export interface ArkImageInputText {
	type: "text";
	text: string;
}

export interface ArkImageInputImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ArkImagesResult {
	api: string;
	provider: string;
	model: string;
	output: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	responseId?: string;
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

interface ArkImageResponseData {
	b64_json?: string | null;
	url?: string | null;
	output_format?: string | null;
	size?: string | null;
	error?: { message?: string | null } | null;
}

interface ArkImageResponse {
	created?: number;
	model?: string;
	data?: ArkImageResponseData[] | null;
	error?: { code?: string | null; message?: string | null } | null;
}

/** ARK takes reference images as `data:<format>;base64,<data>` (format lowercase). */
function toReferenceImage(input: ArkImageInputImage): string {
	return `data:${input.mimeType.toLowerCase()};base64,${input.data}`;
}

function mimeTypeFor(outputFormat: string | null | undefined): string {
	return outputFormat === "png" ? "image/png" : "image/jpeg";
}

/** Split pi's input blocks into ARK's `prompt` and `image` fields. */
export function buildArkImageBody(
	modelId: string,
	input: readonly (ArkImageInputText | ArkImageInputImage)[],
): { body: Record<string, unknown>; ok: boolean } {
	const texts: string[] = [];
	const images: string[] = [];
	for (const item of input) {
		if (item.type === "text") texts.push(item.text);
		else images.push(toReferenceImage(item));
	}
	const prompt = texts.join("\n\n").trim();
	const body: Record<string, unknown> = {
		model: modelId,
		prompt,
		// ARK omits images from a text-to-image prompt only; an empty array is invalid.
		...(images.length > 0 ? { image: images } : {}),
		response_format: "b64_json",
	};
	return { body, ok: prompt.length > 0 };
}

/**
 * Parses a non-streaming ARK image response into pi's `AssistantImages`.
 * Entries without base64 payload are reported as errors rather than skipped
 * silently: ARK returns one entry per requested image and a failure entry
 * carries `error`.
 */
export function parseArkImageResponse(
	payload: ArkImageResponse,
	identity: { api: string; provider: string; model: string },
): ArkImagesResult {
	const result: ArkImagesResult = { ...identity, output: [], stopReason: "stop", timestamp: Date.now() };
	if (payload.error?.message) {
		result.stopReason = "error";
		result.errorMessage = payload.error.message;
		return result;
	}
	const entries = Array.isArray(payload.data) ? payload.data : [];
	const failures: string[] = [];
	for (const entry of entries) {
		if (entry?.b64_json) {
			result.output.push({
				type: "image",
				data: entry.b64_json,
				mimeType: mimeTypeFor(entry.output_format),
			});
			continue;
		}
		if (entry?.error?.message) failures.push(entry.error.message);
	}
	if (result.output.length === 0) {
		result.stopReason = "error";
		result.errorMessage =
			failures.length > 0 ? failures.join("; ") : "ARK returned no base64 image data";
	}
	return result;
}

/** `ProviderImages.generateImages`: one ARK call per generated image request. */
export async function generateArkImages(
	model: { id: string; api: string; provider: string; baseUrl: string },
	context: { input: readonly (ArkImageInputText | ArkImageInputImage)[] },
	options?: ArkImageRequestOptions,
): Promise<ArkImagesResult> {
	const identity = { api: model.api, provider: model.provider, model: model.id };
	const fail = (message: string, stopReason: "error" | "aborted" = "error"): ArkImagesResult => ({
		...identity,
		output: [],
		stopReason,
		errorMessage: message,
		timestamp: Date.now(),
	});

	if (!options?.apiKey) return fail(`No API key for provider: ${model.provider}`);
	const { body, ok } = buildArkImageBody(model.id, context.input);
	if (!ok) return fail("Image generation needs a text prompt");

	const doFetch = options.fetch ?? globalThis.fetch;
	const url = `${model.baseUrl.replace(/\/+$/, "")}${ARK_IMAGES_PATH}`;
	let response: Response;
	try {
		response = await doFetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${options.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				...(options.headers ?? {}),
			},
			body: JSON.stringify(body),
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) return fail("aborted", "aborted");
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let message = `ARK image generation failed: HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(text) as { error?: { message?: string } };
			if (parsed.error?.message) message = parsed.error.message;
		} catch {
			if (text) message += ` ${text.slice(0, 300)}`;
		}
		return fail(message);
	}

	const payload = (await response.json()) as ArkImageResponse;
	return parseArkImageResponse(payload, identity);
}
