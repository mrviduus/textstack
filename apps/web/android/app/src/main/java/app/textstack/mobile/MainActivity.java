package app.textstack.mobile;

import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

/**
 * SPIKE #1629: nginx's job for the reader frame, done by the shell. /reader/frame.html is served from the APK with
 * a fresh nonce per load in place of %READER_FRAME_NONCE% and the headers nginx sends (frame.mjs READER_FRAME_HEADERS).
 */
public class MainActivity extends BridgeActivity {
    private static final SecureRandom RANDOM = new SecureRandom();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if ("/reader/frame.html".equals(request.getUrl().getPath()) && "localhost".equals(request.getUrl().getHost())) {
                    try (InputStream in = getAssets().open("public/reader/frame.html")) {
                        byte[] nonce = new byte[16];
                        RANDOM.nextBytes(nonce);
                        StringBuilder hex = new StringBuilder();
                        for (byte b : nonce) hex.append(String.format("%02x", b));
                        String html = new String(in.readAllBytes(), StandardCharsets.UTF_8).replace("%READER_FRAME_NONCE%", hex);
                        Map<String, String> h = new HashMap<>();
                        h.put("Content-Security-Policy", "frame-ancestors 'self'");
                        h.put("Cache-Control", "no-store, no-transform");
                        h.put("X-Content-Type-Options", "nosniff");
                        h.put("Referrer-Policy", "no-referrer");
                        return new WebResourceResponse("text/html", "utf-8", 200, "OK", h, new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
                    } catch (Exception e) {
                        return null;
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }
        });
    }
}
