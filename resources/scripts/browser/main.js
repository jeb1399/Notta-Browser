const tabs = [];
let activeTabIndex = -1;
const proxyBaseUrl = "/proxy/";
const homepageLink = window.location.href + "homepage.html";
const MAX_TABS = 111;

function createTab(url = homepageLink) {
    if (tabs.length >= MAX_TABS) {alert("Maximum number of tabs reached!")}
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.innerHTML = `
        <span class="tab-title">New Tab</span>
        <span class="close-tab">×</span>
    `;
    document.getElementById("tabs").insertBefore(tab, null);
    const n = tabs.length;
    tabs.push({ url: url, title: "New Tab" });
    tab.addEventListener("click", () => activateTab(n));
    tab.querySelector(".close-tab").addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(n);
    });
    activateTab(n);
}

function activateTab(index) {
    document.querySelectorAll(".tab").forEach((tab, n) => {
        tab.classList.toggle("active", n === index);
    });
    activeTabIndex = index;
    loadURL(tabs[index].url);
}

function closeTab(index) {
    tabs.splice(index, 1);
    document.querySelectorAll(".tab")[index].remove();
    if (tabs.length === 0) {
        createTab();
    } else {
        activateTab(Math.min(index, tabs.length - 1));
    }
}

function updateTabTitle(title) {
    tabs[activeTabIndex].title = title;
    document.querySelectorAll(".tab")[activeTabIndex].querySelector(".tab-title").textContent = title;
}

function loadURL(url) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
    }
    const proxyUrl = window.location.origin + proxyBaseUrl + url;
    document.getElementById("addressBar").value = url;
    document.getElementById("webview").src = proxyUrl;
    tabs[activeTabIndex].url = url;
}

document.getElementById("webview").addEventListener("load", () => {
    const webview = document.getElementById("webview");
    const currentURL = webview.contentWindow.location.href;
    if (currentURL !== tabs[activeTabIndex].url) {
        tabs[activeTabIndex].url = currentURL;
        const cleanedURL = currentURL.replace(/.*\/proxy\//, '');
        document.getElementById("addressBar").value = cleanedURL;
        updateTabTitle(webview.contentDocument.title || "New Tab");
    }

    webview.contentWindow.document.body.addEventListener('click', function (e) {
        const target = e.target.closest('a[target="_blank"], a[target="new"]');
        if (target) {
            e.preventDefault();
            const newUrl = target.href;
            createTab(newUrl);
        }
    });
});

document.getElementById("newTab").addEventListener("click", () => createTab());
document.getElementById("addressBar").addEventListener("keypress", (e) => {if (e.key === "Enter") loadURL(e.target.value);});
document.getElementById("back").addEventListener("click", () => {document.getElementById("webview").contentWindow.history.back();});
document.getElementById("forward").addEventListener("click", () => {document.getElementById("webview").contentWindow.history.forward();});
document.getElementById("reload").addEventListener("click", () => {document.getElementById("webview").contentWindow.location.reload();});
document.getElementById("bookmark").addEventListener("click", () => {
    const url = tabs[activeTabIndex].url;
    alert(`Bookmarked: ${url}`);
});
document.getElementById("settings").addEventListener("click", () => {
    document.getElementById("settingsPage").style.display = "block";
});
document.getElementById("tDarkMode").addEventListener("click", () => {
    document.body.classList.toggle("dark-mode");
    document.getElementById("tDarkMode").textContent = document.body.classList.contains("dark-mode") ? "☀️" : "🌙";
});

function applySettings(settings) {
    if (settings.zoomLevel) {
        document.body.style.zoom = settings.zoomLevel + '%';
    }
    if (settings.fontSize) {
        document.body.style.fontSize = settings.fontSize + 'px';
    }
    if (settings.enableCookies) {
        document.cookie = "cookiesEnabled=true; SameSite=Strict; Secure";
    } else {
        document.cookie = "cookiesEnabled=false; SameSite=Strict; Secure";
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const saveSettingsButton = document.getElementById("saveSettings");
    const cancelButton = document.getElementById("closeBtn");
    if (saveSettingsButton) {
        saveSettingsButton.addEventListener("click", () => {
            const settings = {
                zoomLevel: document.getElementById("zoomLevel").value,
                fontSize: document.getElementById("fontSize").value,
                enableCookies: document.getElementById("enableCookies").checked
            };
            applySettings(settings);
            document.getElementById("settingsPage").style.display = "none";
        });
        cancelButton.addEventListener("click", function() {document.getElementById("settingsPage").style.display = "none";});
    }

    const zoomLevel = document.getElementById("zoomLevel");
    const zoomLevelNumber = document.getElementById("zoomLevelNumber");
    zoomLevel.addEventListener("input", () => {
        zoomLevelNumber.value = zoomLevel.value;
    });
    zoomLevelNumber.addEventListener("input", () => {
        zoomLevel.value = zoomLevelNumber.value;
    });

    const fontSize = document.getElementById("fontSize");
    const fontSizeNumber = document.getElementById("fontSizeNumber");
    fontSize.addEventListener("input", () => {
        fontSizeNumber.value = fontSize.value;
    });
    fontSizeNumber.addEventListener("input", () => {
        fontSize.value = fontSizeNumber.value;
    });
});

createTab();
