package app.textstack.mobile;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves the reader frame as nginx does on the web (ADR-032, packages/reader/src/frame.mjs): /reader/frame.html
 * from the APK, with a fresh nonce in place of the placeholder on every load, and the frame's headers.
 * scripts/check-reader-frame.mjs holds the path, the placeholder and the headers equal to frame.mjs.
 * If this fails, the answer is an empty 500 with the same headers: the reader stays blank and logcat says why.
 * The frame always comes from the APK assets (no live update of the web bundle).
 */
public class ReaderFrameClient extends BridgeWebViewClient {
    static final String FRAME_PATH = "/reader/frame.html";
    static final String NONCE_PLACEHOLDER = "%READER_FRAME_NONCE%";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Bridge bridge;

    public ReaderFrameClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    static Map<String, String> frameHeaders() {
        Map<String, String> h = new HashMap<>();
        h.put("Content-Security-Policy", "frame-ancestors 'self'");
        h.put("Cache-Control", "no-store, no-transform");
        h.put("X-Content-Type-Options", "nosniff");
        h.put("Referrer-Policy", "no-referrer");
        h.put("X-Robots-Tag", "noindex");
        return h;
    }

    /** 16 random bytes, hex: the form of nginx's `$request_id`. */
    static String newNonce() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        StringBuilder hex = new StringBuilder(32);
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (!FRAME_PATH.equals(request.getUrl().getPath()) || !bridge.getHost().equals(request.getUrl().getHost())) {
            return super.shouldInterceptRequest(view, request);
        }
        try (InputStream in = bridge.getContext().getAssets().open("public" + FRAME_PATH)) {
            // Not InputStream.readAllBytes: Android has it from API 33, the app runs from 24.
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int n; (n = in.read(chunk)) != -1; ) bytes.write(chunk, 0, n);
            String html = bytes.toString("UTF-8");
            if (!html.contains(NONCE_PLACEHOLDER)) throw new IllegalStateException("frame.html has no nonce placeholder");
            return response(200, "OK", html.replace(NONCE_PLACEHOLDER, newNonce()));
        } catch (Exception e) {
            // Never Capacitor's own answer for this path: it has no frame headers and can inject a script.
            Logger.error("ReaderFrameClient", "The reader frame was not served", e);
            return response(500, "Reader frame error", "");
        }
    }

    private static WebResourceResponse response(int status, String reason, String html) {
        return new WebResourceResponse(
            "text/html", "utf-8", status, reason, frameHeaders(), new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
    }
}
