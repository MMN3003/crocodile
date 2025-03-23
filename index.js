require("dotenv").config(); // Load .env file
const fs = require("fs").promises;
const path = require("path");
const puppeteer = require("puppeteer");
const sqlite3 = require("sqlite3").verbose(); // SQLite3 for database

// Configuration from .env
const START_URL = process.env.START_URL;
const MAX_CONCURRENT_PAGES = parseInt(process.env.MAX_CONCURRENT_PAGES, 10);
const CRAWL_DELAY = parseInt(process.env.CRAWL_DELAY, 10);
const SAVE_INTERVAL = parseInt(process.env.SAVE_INTERVAL, 10);
const DB_FILE = path.resolve(__dirname, process.env.DB_FILE || "crawler.db");

// State management
let visitedUrls = new Set();
let queue = [];
let activeTasks = 0;
let saveTimeout;

// Media patterns
const VIDEO_EXTENSIONS = /\.(mp4|mkv)(\?.*)?$/i;
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png)(\?.*)?$/i;

// Initialize SQLite database
// In database connection handler
const db = new sqlite3.Database(
  DB_FILE,
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) {
      console.error("Error opening database:", err.message);
      console.log("Full path:", DB_FILE); // Add this for debugging
    } else {
      console.log("Connected to SQLite database");
      initializeDatabase();
    }
  }
);

// Create tables if they don't exist
function initializeDatabase() {
  db.serialize(() => {
    db.run(
      `
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `,
      (result, err) => {
        console.log("Created pages table", result, err);
      }
    );

    db.run(
      `
     CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    type TEXT NOT NULL,
    season TEXT,
    episode TEXT,
    resolution TEXT,
    FOREIGN KEY (page_id) REFERENCES pages(id)
  )
    `,
      (result, err) => {
        console.log("Created media table", result, err);
      }
    );
    db.run("CREATE INDEX IF NOT EXISTS idx_media_page_id ON media(page_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_pages_name ON pages(name)");
  });
}

// Ensure media directory exists
async function ensureMediaDir() {
  try {
    await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
    console.log(`Database directory created at: ${path.dirname(DB_FILE)}`);
  } catch (error) {
    console.error("Error creating database directory:", error.message);
  }
}

// Load crawler state from file
async function loadState() {
  try {
    const data = await fs.readFile(
      path.resolve(__dirname, "crawler-state.json"),
      "utf8"
    );
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
    await fs.writeFile(
      path.resolve(__dirname, "crawler-state.json"),
      JSON.stringify(state, null, 2)
    );
    console.log(
      `Saved state: ${visitedUrls.size} visited URLs, ${queue.length} URLs in queue`
    );
  } catch (error) {
    console.error("Error saving state:", error.message);
  }
}

// Save page and media URLs to SQLite database
async function savePageMediaUrls(pageUrl, mediaUrls) {
  return new Promise((resolve, reject) => {
    console.log(`Saving media URLs for page: ${pageUrl}`);
    // return  if there is not mkv file in mediaUrls
    if (!mediaUrls.some(({ url }) => url.endsWith(".mkv"))) return resolve();
    // delete media url that ends with logo40.png
    mediaUrls = mediaUrls.filter(({ url }) => !url.endsWith("logo40.png"));
    const pageName = pageUrl.split("/").pop().replace(/-/g, " "); // Replace '-' with spaces
    db.serialize(() => {
      db.run(
        "INSERT OR IGNORE INTO pages (name) VALUES (?)",
        [pageName],
        function (err) {
          if (err) return reject(err);

          const pageId = this.lastID;
          const stmt = db.prepare(`
            INSERT INTO media (page_id, url, type, season, episode, resolution)
            VALUES (?, ?, ?, ?, ?, ?)
          `);

          mediaUrls.forEach(({ url, type }) => {
            const { season, episode } = extractSeasonAndEpisode(url);
            const resolution = extractResolution(url);
            console.log({ season, episode, resolution, url, type });
            stmt.run(
              pageId,
              url,
              type,
              season || null,
              episode || null,
              resolution || null
            );
          });

          stmt.finalize((err) => {
            if (err) return reject(err);
            console.log(
              `Saved ${mediaUrls.length} media URLs for page: ${pageName}`
            );
            resolve();
          });
        }
      );
    });
  });
}
// Add this function near your media patterns
const extractSeasonAndEpisode = (url) => {
  let season = "01"; // Default season
  let episode = null;

  // 1. Extract filename from URL
  const filename = decodeURIComponent(url)
    .split("/")
    .pop() // Get last path segment
    .split("?")[0]; // Remove query parameters

  // 2. Prioritize filename-based season detection
  const filenameSeasonMatch = filename.match(/[Ss](?:eason)?[\s\._-]?(\d+)/i);
  if (filenameSeasonMatch) {
    season = filenameSeasonMatch[1].padStart(2, "0");
  }

  // 3. Episode extraction with multiple fallbacks
  const episodeMatch = filename.match(
    /(?:[Ee](?:pisode)?[\s\._-]?(\d+)|(\d+)(?:\.\d{3,4}p)|x(\d+))/i
  );

  episode = [1, 2, 3]
    .reduce(
      (acc, idx) => acc || episodeMatch?.[idx]?.replace(/\D/g, "") || null,
      null
    )
    ?.padStart(2, "0");

  // 4. Path-based season fallback
  if (!filenameSeasonMatch) {
    const pathSeasonMatch = url.match(/\/S(\d+)\//i);
    if (pathSeasonMatch) season = pathSeasonMatch[1].padStart(2, "0");
  }

  // 5. Final validation
  return {
    season: season.length === 2 ? season : "01",
    episode: episode?.length <= 3 ? episode : null,
  };
};

const extractResolution = (url) => {
  const resMatch = url.match(/(\d{3,4})(?:p|P)/);
  return resMatch ? `${resMatch[1]}P` : null;
};
async function crawl() {
  const browser = await puppeteer.launch({
    headless: "new", // Use the new headless mode
    args: [
      "--no-sandbox", // Required for Linux
      "--disable-setuid-sandbox", // Required for Linux
      "--disable-dev-shm-usage", // Avoids memory issues
    ],
  });
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
    db.close();
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
        const allMediaUrls = [
          ...result.images.map((url) => ({ url, type: "image" })),
          ...result.videos.map((url) => ({ url, type: "video" })),
        ];
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
  await ensureMediaDir(); // Ensure database directory exists
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
