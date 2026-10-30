package nl.rarevogel.dmdspeler;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * DMD Player: a WebView with the bundled page. The page is served from https://dmd.local/ (out of the APK assets)
 * so it gets a normal web origin with IndexedDB for the library. This class adds a file picker, saving files
 * (GIF export), full screen in landscape and the back button.
 */
public class MainActivity extends Activity {
    private static final String HOST = "https://dmd.local/";
    private static final int PICK_FILES = 1, SAVE_FILE = 2;
    private WebView web;
    private ValueCallback<Uri[]> pending;
    private byte[] toSave;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0e0c0b"));
        w.setNavigationBarColor(Color.parseColor("#0e0c0b"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e0c0b"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "DMDApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                if (!url.startsWith(HOST)) return null;
                String path = Uri.parse(url).getPath();
                if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
                try {
                    InputStream in = getAssets().open(path.substring(1));
                    return new WebResourceResponse(mime(path), "UTF-8", in);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", null);
                }
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith(HOST)) return false;
                Uri u = Uri.parse(url);
                if ("http".equals(u.getScheme()) || "https".equals(u.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* no browser */ }
                    return true;
                }
                return false;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pending != null) pending.onReceiveValue(null);
                pending = callback;
                // .vpx, .fpt and .vpt have no MIME type of their own, so allow any file
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose a table, GIF or ZIP"), PICK_FILES);
                } catch (Exception e) {
                    pending.onReceiveValue(null);
                    pending = null;
                    return false;
                }
                return true;
            }
        });

        setContentView(web);
        if (state != null) web.restoreState(state);
        else web.loadUrl(HOST + "index.html");
    }

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    /** Called from the page as window.DMDApp. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(final String name, final String mimeType, final String base64) {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    toSave = Base64.decode(base64, Base64.DEFAULT);
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(mimeType);
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    startActivityForResult(i, SAVE_FILE);
                } catch (Exception e) {
                    toSave = null;
                    web.evaluateJavascript("window.onSaved && onSaved(false)", null);
                }
            } });
        }

        @JavascriptInterface
        public void setFullscreen(final boolean on) {
            runOnUiThread(new Runnable() { public void run() { fullscreen(on); } });
        }
    }

    private void fullscreen(boolean on) {
        View d = getWindow().getDecorView();
        if (on) {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } else {
            d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_USER);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == SAVE_FILE) {
            boolean ok = false;
            if (result == RESULT_OK && data != null && data.getData() != null && toSave != null) {
                try {
                    OutputStream out = getContentResolver().openOutputStream(data.getData());
                    out.write(toSave);
                    out.close();
                    ok = true;
                } catch (Exception e) { ok = false; }
            }
            toSave = null;
            web.evaluateJavascript("window.onSaved && onSaved(" + ok + ")", null);
            return;
        }
        if (request != PICK_FILES || pending == null) { super.onActivityResult(request, result, data); return; }
        Uri[] uris = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                uris = new Uri[clip.getItemCount()];
                for (int k = 0; k < uris.length; k++) uris[k] = clip.getItemAt(k).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[] { data.getData() };
            }
        }
        pending.onReceiveValue(uris);
        pending = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.atlasBack ? atlasBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        });
    }
}
