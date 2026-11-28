package app.robodinghy.helper;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Bundle;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Exports the launcher app list and icons for the RoboDinghy host.
 *
 *   am instrument -w [-e size 256] [-e out <absolute dir>] app.robodinghy.helper/.Export
 *
 * Writes apps.json ([{label, package, activity, system}]) and one
 * <package>.png per app into getExternalFilesDir(null)/export (i.e.
 * /sdcard/Android/data/app.robodinghy.helper/files/export), clearing it first.
 * Finishes with result keys RESULT=ok, count=<n>, dir=<path>, or
 * RESULT=error, message=<text>.
 */
public class Export extends Instrumentation {
    private static final int DEFAULT_SIZE = 256;
    private Bundle args;

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        args = arguments != null ? arguments : new Bundle();
        start();
    }

    @Override
    public void onStart() {
        super.onStart();
        Bundle result = new Bundle();
        int code = Activity.RESULT_OK;
        try {
            int size = parseSize(args.getString("size"));
            File dir = outputDir(args.getString("out"));
            int count = export(dir, size);
            result.putString("RESULT", "ok");
            result.putString("count", Integer.toString(count));
            result.putString("dir", dir.getAbsolutePath());
        } catch (Throwable t) {
            code = Activity.RESULT_CANCELED;
            String msg = t.getMessage();
            result.putString("RESULT", "error");
            result.putString("message", t.getClass().getSimpleName() + (msg != null ? ": " + msg : ""));
        }
        finish(code, result);
    }

    private static int parseSize(String s) {
        if (s == null || s.isEmpty()) return DEFAULT_SIZE;
        int n = Integer.parseInt(s.trim());
        if (n < 16 || n > 1024) throw new IllegalArgumentException("size must be 16..1024, got " + n);
        return n;
    }

    private File outputDir(String out) throws Exception {
        File dir;
        if (out != null && !out.isEmpty()) {
            dir = new File(out);
        } else {
            File base = getTargetContext().getExternalFilesDir(null);
            if (base == null) throw new IllegalStateException("external storage not available");
            dir = new File(base, "export");
        }
        if (dir.exists()) deleteContents(dir);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("cannot create " + dir);
        return dir;
    }

    private static void deleteContents(File dir) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) deleteContents(f);
            f.delete();
        }
    }

    private int export(File dir, int size) throws Exception {
        Context ctx = getTargetContext();
        PackageManager pm = ctx.getPackageManager();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> found = pm.queryIntentActivities(main, PackageManager.MATCH_ALL);

        final List<JSONObject> apps = new ArrayList<>();
        Set<String> seenPackages = new HashSet<>();
        for (ResolveInfo ri : found) {
            ActivityInfo ai = ri.activityInfo;
            if (ai == null || ctx.getPackageName().equals(ai.packageName)) continue;
            // One entry per package (the first launcher activity), matching the
            // <package>.png icon naming.
            if (!seenPackages.add(ai.packageName)) continue;
            ApplicationInfo app = ai.applicationInfo;
            boolean system = app != null
                && (app.flags & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
            CharSequence label = ri.loadLabel(pm);

            JSONObject o = new JSONObject();
            o.put("label", label != null ? label.toString().trim() : ai.packageName);
            o.put("package", ai.packageName);
            o.put("activity", ai.name);
            o.put("system", system);
            apps.add(o);

            try {
                Drawable d = ri.loadIcon(pm);
                Bitmap bmp = render(d, size);
                try (FileOutputStream fos = new FileOutputStream(new File(dir, ai.packageName + ".png"))) {
                    bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
                }
                bmp.recycle();
            } catch (Throwable t) {
                // A broken icon must not lose the app; the host uses a generic icon.
            }
        }

        Collections.sort(apps, (a, b) -> a.optString("label").toLowerCase(Locale.ROOT)
            .compareTo(b.optString("label").toLowerCase(Locale.ROOT)));
        JSONArray arr = new JSONArray();
        for (JSONObject o : apps) arr.put(o);

        File tmp = new File(dir, "apps.json.tmp");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
            w.write(arr.toString());
            w.write("\n");
        }
        if (!tmp.renameTo(new File(dir, "apps.json"))) throw new IllegalStateException("cannot write apps.json");
        return apps.size();
    }

    /** Renders any icon drawable to a size x size ARGB bitmap. */
    static Bitmap render(Drawable d, int size) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        if (d == null) return out;
        Canvas c = new Canvas(out);
        if (d instanceof AdaptiveIconDrawable) {
            // Full-bleed square, no mask: the layers are 108dp with the visible
            // 72dp in the middle, so draw them 1.5x oversized and centred
            // (25% overhang on every side), exactly as a launcher does before
            // clipping to its shape. The host applies its own rounding.
            AdaptiveIconDrawable a = (AdaptiveIconDrawable) d;
            int inset = size / 4;
            Rect r = new Rect(-inset, -inset, size + inset, size + inset);
            Drawable bg = a.getBackground();
            Drawable fg = a.getForeground();
            if (bg != null) { bg = bg.mutate(); bg.setBounds(r); bg.draw(c); }
            if (fg != null) { fg = fg.mutate(); fg.setBounds(r); fg.draw(c); }
        } else if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) {
            Bitmap src = ((BitmapDrawable) d).getBitmap();
            Paint p = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
            c.drawBitmap(src, null, new Rect(0, 0, size, size), p);
        } else {
            d = d.mutate();
            d.setBounds(0, 0, size, size);
            d.draw(c);
        }
        return out;
    }
}
