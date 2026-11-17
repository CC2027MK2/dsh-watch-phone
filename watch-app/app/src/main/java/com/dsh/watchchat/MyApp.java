package com.dsh.watchchat;

import android.app.Application;
import android.content.Context;

/**
 * Tiny Application subclass so helper classes can grab a Context without
 * threading one through every constructor.
 */
public final class MyApp extends Application {
    private static MyApp instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    public static Context context() {
        return instance;
    }
}
