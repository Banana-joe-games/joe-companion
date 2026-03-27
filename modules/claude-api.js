// ── Claude API client for Joe modules ──
const https = require("https");
const { getConfig, log } = require("./config");

function callClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    if (!config.apiKey) {
      log("No API key configured");
      return reject(new Error("No API key"));
    }

    const model = options.model || "claude-haiku-4-5-20251001";
    const messages = [{ role: "user", content: options.imageBase64
      ? [
          { type: "image", source: { type: "base64", media_type: options.mediaType || "image/png", data: options.imageBase64 } },
          { type: "text", text: prompt },
        ]
      : prompt
    }];

    const body = JSON.stringify({
      model,
      max_tokens: options.maxTokens || 300,
      messages,
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            log(`Claude API error: ${json.error.message}`);
            return reject(new Error(json.error.message));
          }
          const text = json.content?.[0]?.text || "";
          resolve(text);
        } catch(e) {
          log(`Claude API parse error: ${e.message}`);
          reject(e);
        }
      });
    });

    req.on("error", (e) => { log(`Claude API request error: ${e.message}`); reject(e); });
    req.write(body);
    req.end();
  });
}

// Parse JSON from Claude response (handles markdown code blocks)
function parseJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch(e) {}
  return null;
}

module.exports = { callClaude, parseJSON };
