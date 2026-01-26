(() => {
    const KEY = "ontogsn.theme";
    const root = document.documentElement;

    function apply(theme) {
        root.dataset.theme = theme;
        // optional: helps built-in form controls match
        root.style.colorScheme = theme === "dark" ? "dark" : "light";
    }

    const light = document.getElementById("hl-light");
    const dark = document.getElementById("hl-dark");
    if (light && dark) {
        dark.disabled = theme !== "dark";
        light.disabled = theme === "dark";
    }

    const stored = localStorage.getItem(KEY);
    const prefersDark =
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches;

    // initial theme
    apply(stored || (prefersDark ? "dark" : "light"));

    // small global API
    window.OntoTheme = {
        get: () => root.dataset.theme,
        set: (t) => {
            apply(t);
            localStorage.setItem(KEY, t);
            window.dispatchEvent(new CustomEvent("ontogsn:theme", { detail: { theme: t } }));
        },
        toggle: () => {
            const next = root.dataset.theme === "dark" ? "light" : "dark";
            window.OntoTheme.set(next);
            return next;
        }
    };

    // If user didn't explicitly pick a theme, follow OS changes
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", (e) => {
        if (localStorage.getItem(KEY)) return; // user override exists
        apply(e.matches ? "dark" : "light");
    });
})();
