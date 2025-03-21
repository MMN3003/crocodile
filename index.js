require("dotenv").config(); // Load .env file
const fs = require("fs").promises;
const path = require("path");
const puppeteer = require("puppeteer");

// Configuration from .env
const START_URL = process.env.START_URL;
const MAX_CONCURRENT_PAGES = parseInt(process.env.MAX_CONCURRENT_PAGES, 10);
const CRAWL_DELAY = parseInt(process.env.CRAWL_DELAY, 10);
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL, 10);
const MEDIA_DIR = path.resolve(__dirname, process.env.MEDIA_DIR);
const STATE_FILE = path.resolve(__dirname, process.env.STATE_FILE);

// State management
let visitedUrls = new Set();
let queue = [];
let activeTasks = 0;
let saveTimeout;

// Media patterns
const VIDEO_EXTENSIONS =
  /\.(mp4|mov|avi|mkv|webm|flv|wmv|mpeg|mpg|3gp)(\?.*)?$/i;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|gif|bmp|webp|svg|tiff)(\?.*)?$/i;

// Ensure media directory exists
async function ensureMediaDir() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    console.log(`Media directory created at: ${MEDIA_DIR}`);
  } catch (error) {
    console.error("Error creating media directory:", error.message);
  }
}

// Load crawler state from file
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    const state = JSON.parse(data);
    visitedUrls = new Set(state.visitedUrls);
    queue = state.queue;
    console.log(
      `Loaded state: ${visitedUrls.size} visited URLs, ${queue.length} URLs in queue`
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No existing state file, starting fresh");
    } else {
      console.error("Error loading state:", error.message);
    }
  }
}

// Save crawler state to file
async function saveState() {
  try {
    const state = {
      visitedUrls: Array.from(visitedUrls),
      queue: queue,
    };
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(
      `Saved state: ${visitedUrls.size} visited URLs, ${queue.length} URLs in queue`
    );
  } catch (error) {
    console.error("Error saving state:", error.message);
  }
}

// Save media URLs for a specific page
async function savePageMediaUrls(pageUrl, mediaUrls) {
  try {
    if (!mediaUrls.some((url) => url.endsWith(".mkv"))) return;
    mediaUrls = mediaUrls.filter((url) => !url.endsWith("logo40.png"));
    const fileName = pageUrl.split("/").pop() || "index"; // Use last part of URL as file name
    const filePath = path.resolve(MEDIA_DIR, `${fileName}.txt`);
    await fs.writeFile(filePath, mediaUrls.join("\n"));
    console.log(
      `Saved ${mediaUrls.length} media URLs for ${pageUrl} to ${filePath}`
    );
  } catch (error) {
    console.error(`Error saving media URLs for ${pageUrl}:`, error.message);
  }
}

async function crawl() {
  const browser = await puppeteer.launch({ headless: "new" });

  // Setup periodic saving
  const scheduleSave = () => {
    saveTimeout = setTimeout(async () => {
      await saveState();
      scheduleSave();
    }, SAVE_INTERVAL);
  };
  scheduleSave();

  // Graceful shutdown handler
  process.on("SIGINT", async () => {
    console.log("\nGracefully shutting down...");
    clearTimeout(saveTimeout);
    await saveState();
    await browser.close();
    process.exit();
  });

  while (true) {
    if (queue.length > 0 && activeTasks < MAX_CONCURRENT_PAGES) {
      const url = queue.shift();
      const parsedUrl = new URL(url);
      const normalizedUrl = parsedUrl.origin + parsedUrl.pathname;

      if (visitedUrls.has(normalizedUrl)) {
        continue;
      }

      visitedUrls.add(normalizedUrl);
      activeTasks++;

      try {
        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (compatible; MyCrawler/1.0)");

        console.log(`Visiting: ${url}`);
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        // Extract content
        const result = await page.evaluate(
          (imgPatternStr, vidPatternStr) => {
            // Convert string patterns back to RegExp
            const imgPattern = new RegExp(imgPatternStr);
            const vidPattern = new RegExp(vidPatternStr);

            const data = {
              images: new Set(),
              videos: new Set(),
              links: new Set(),
            };

            // Extract images
            document.querySelectorAll("img").forEach((img) => {
              if (img.src && !img.src.startsWith("data:")) {
                // Ignore data: URLs
                data.images.add(img.src);
              }
            });

            // Extract videos
            document
              .querySelectorAll("video source, audio source, embed, iframe")
              .forEach((element) => {
                const src = element.src || element.getAttribute("data-src");
                if (src && !src.startsWith("data:")) {
                  // Ignore data: URLs
                  data.videos.add(src);
                }
              });

            // Find media links
            document.querySelectorAll("a").forEach((a) => {
              const href = a.href;
              if (href && !href.startsWith("data:")) {
                // Ignore data: URLs
                if (vidPattern.test(href)) data.videos.add(href);
                if (imgPattern.test(href)) data.images.add(href);
                data.links.add(href);
              }
            });

            return {
              images: [...data.images],
              videos: [...data.videos],
              links: [...data.links],
            };
          },
          IMAGE_EXTENSIONS.source,
          VIDEO_EXTENSIONS.source
        ); // Pass the regex source as strings

        // Process results
        console.log(`Found on ${url}:`);
        console.log("Images:", result.images);
        console.log("Videos:", result.videos);

        // Save media URLs for this page
        const allMediaUrls = [...result.images, ...result.videos];
        await savePageMediaUrls(url, allMediaUrls);

        // Add new links to queue
        result.links.forEach((link) => {
          const parsedLink = new URL(link, url);
          const normalizedLink = parsedLink.origin + parsedLink.pathname;

          if (
            parsedLink.origin === parsedUrl.origin &&
            !visitedUrls.has(normalizedLink)
          ) {
            queue.push(parsedLink.href);
          }
        });

        await page.close();
      } catch (error) {
        console.error(`Error crawling ${url}:`, error.message);
      }

      activeTasks--;
      await new Promise((resolve) => setTimeout(resolve, CRAWL_DELAY));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// Initialization
async function main() {
  await ensureMediaDir(); // Ensure media directory exists
  await loadState(); // Load saved state

  const startUrl = new URL(START_URL);
  const normalizedStartUrl = startUrl.origin + startUrl.pathname;

  if (!visitedUrls.has(normalizedStartUrl)) {
    queue.push(START_URL);
    console.log(`Starting crawl from: ${START_URL}`);
  } else {
    console.log(`Initial URL already visited: ${START_URL}`);
  }

  crawl().catch((error) => console.error("Crawler failed:", error));
}

main();
