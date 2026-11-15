package org.marsexplorer.evaplanner;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The whole app: starts the planner's Python backend on the phone (android_server.py) and shows the planner's page
 * from it in a full-screen web view. Links to other sites open in the phone's browser.
 */
public class MainActivity extends Activity {
    private static final String TAG = "MarsEVAPlanner";
    private static final int PICK_FILE = 1;
    private static final int BACKGROUND = 0xFF1C1412;

    private WebView web;
    private ValueCallback<Uri[]> pickedFile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep the page clear of the status bar, navigation bar, camera cut-out and on-screen keyboard.
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        web = new WebView(this);
        web.setBackgroundColor(BACKGROUND);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);  // the page remembers the theme and the last plan
        web.addJavascriptInterface(new AppBridge(), "marsEvaApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("127.0.0.1".equals(uri.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // no browser to open it in
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pickedFile != null) {
                    pickedFile.onReceiveValue(null);
                }
                pickedFile = callback;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException error) {
                    pickedFile = null;
                    return false;
                }
            }
        });

        showMessage("Mars EVA Planner", "Loading the terrain…\nThe first start can take a minute.");
        new Thread(this::startPlanner, "planner-start").start();
    }

    /** Start Python and the backend (slow: off the main thread), then open the planner. */
    private void startPlanner() {
        try {
            if (!Python.isStarted()) {
                Python.start(new AndroidPlatform(this));
            }
            String url = Python.getInstance().getModule("android_server").callAttr("start").toString();
            runOnUiThread(() -> web.loadUrl(url));
        } catch (Throwable error) {
            Log.e(TAG, "The planner could not start", error);
            String detail = String.valueOf(error.getMessage());
            runOnUiThread(() -> showMessage("The planner could not start", detail));
        }
    }

    private void showMessage(String title, String text) {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>html,body{height:100%;margin:0;background:#1c1412;color:#f3e6dc;"
                + "font:15px/1.5 system-ui,sans-serif}body{display:grid;place-items:center;text-align:center;padding:24px;"
                + "box-sizing:border-box}.planet{width:72px;height:72px;margin:0 auto 20px;border-radius:50%;"
                + "background:radial-gradient(circle at 35% 35%,#e0622a,#c1440e 55%,#7a2a08)}h1{font-size:20px;"
                + "font-weight:600;margin:0 0 6px}p{margin:0;color:#c9b3a5;white-space:pre-wrap}</style></head><body><div>"
                + "<div class='planet'></div><h1>" + TextUtils.htmlEncode(title) + "</h1><p>" + TextUtils.htmlEncode(text)
                + "</p></div></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE && pickedFile != null) {
            pickedFile.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            pickedFile = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /** Called by the page (frontend/src/main.ts) to save a route file, which a web view cannot do by itself. */
    private class AppBridge {
        @JavascriptInterface
        public String saveFile(String name, String text) throws IOException {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new IOException("the Downloads folder is not available");
                }
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        throw new IOException("the Downloads folder is not available");
                    }
                    out.write(bytes);
                }
                return "Downloads";
            }
            File folder = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (folder == null) {
                throw new IOException("storage is not available");
            }
            File file = new File(folder, name);
            try (OutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            return file.getPath();
        }
    }
}
