/**
 * Vendored from @tencent-weixin/openclaw-weixin@2.4.10 (MIT).
 *
 * Copyright (C) 2026 Tencent. All rights reserved.
 * openclaw-weixin is licensed under the MIT license. The upstream package
 * declares `openclaw` as a peerDependency and statically imports it from
 * unrelated modules; vendoring the two helpers we actually use lets us drop
 * the whole 342 MB dependency tree from the startup path.
 *
 * Source: dist/src/api/api.js
 * Do not edit logic here — keep it byte-identical to upstream so upgrades
 * remain a straight diff.
 */
// @ts-nocheck — upstream is untyped JS; kept byte-identical on purpose.

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);
/**
 * Quote uint64 message identifiers before JSON.parse sees them. This scanner
 * only rewrites actual object properties, never matching text inside JSON strings.
 */
export function parseWeixinApiJson(rawText) {
    let output = "";
    let index = 0;
    while (index < rawText.length) {
        if (rawText[index] !== '"') {
            output += rawText[index++];
            continue;
        }
        const stringStart = index;
        index++;
        let escaped = false;
        while (index < rawText.length) {
            const char = rawText[index++];
            if (escaped) {
                escaped = false;
            }
            else if (char === "\\") {
                escaped = true;
            }
            else if (char === '"') {
                break;
            }
        }
        const stringToken = rawText.slice(stringStart, index);
        output += stringToken;
        let cursor = index;
        while (/\s/.test(rawText[cursor] ?? ""))
            cursor++;
        if (rawText[cursor] !== ":")
            continue;
        let key;
        try {
            key = JSON.parse(stringToken);
        }
        catch {
            continue;
        }
        if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key))
            continue;
        output += rawText.slice(index, cursor + 1);
        cursor++;
        while (/\s/.test(rawText[cursor] ?? "")) {
            output += rawText[cursor++];
        }
        const numberStart = cursor;
        if (rawText[cursor] === "-")
            cursor++;
        while (/\d/.test(rawText[cursor] ?? ""))
            cursor++;
        if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
            output += `"${rawText.slice(numberStart, cursor)}"`;
            index = cursor;
        }
        else {
            index = numberStart;
        }
    }
    return JSON.parse(output);
}
