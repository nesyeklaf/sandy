module.exports = ({ config }) => {
  const variant = process.env.SANDY_MOBILE_VARIANT ?? "production";
  if (variant !== "production" && variant !== "dev") {
    throw new Error("SANDY_MOBILE_VARIANT must be production or dev");
  }
  const isDev = variant === "dev";
  return {
    ...config,
    extra: { ...config.extra, sandyMobileVariant: variant },
    ...(isDev
      ? {
          name: "sandy dev",
          icon: "./assets/icon-dev.png",
          web: { ...config.web, favicon: "./assets/favicon-dev.png" },
          plugins: config.plugins.map((plugin) =>
            Array.isArray(plugin) && plugin[0] === "expo-splash-screen"
              ? [
                  plugin[0],
                  {
                    ...plugin[1],
                    image: "./assets/splash-logo-dev.png",
                    dark: {
                      ...plugin[1].dark,
                      image: "./assets/splash-logo-dev.png",
                    },
                  },
                ]
              : plugin,
          ),
        }
      : {}),
    android: {
      ...config.android,
      ...(isDev
        ? {
            package: "app.sandy.mobile.dev",
            intentFilters: [],
            adaptiveIcon: {
              ...config.android.adaptiveIcon,
              foregroundImage: "./assets/android-icon-foreground-dev.png",
            },
          }
        : {}),
    },
  };
};
