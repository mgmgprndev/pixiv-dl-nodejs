import { createWriteStream } from 'fs';
import { unlink, mkdir, writeFile, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { dirname, resolve as resolvePath } from 'path';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
import ffmpeg from 'fluent-ffmpeg';
import crypto from 'crypto';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const ask = (q) =>
  new Promise((r) => {
    rl.question(q, (ans) => {
      rl.close();
      r(ans);
    });
  });

const PHPSESSIDs = [
    // F12（開発者ツール）> Application で、Cookieをみて。
    //「PHPSESSID」を取る。
];
const PHPSESSID = PHPSESSIDs[Math.floor(Math.random() * PHPSESSIDs.length)];


const IID = await ask("Illust Id? ");
const result = await download(IID);
if ( result["success"] ) {
    const data = result["data"];
    console.log("✅ " + data["type"] + "「" +  data["title"] + "」のダウンロード成功");
    console.log("データー：\n" + JSON.stringify(data));
    console.log("-=".repeat(11).slice(1));
}

async function download(sessionKey, artworkId, downloadDir) {
    const UUID = crypto.randomBytes(16).toString("hex");
    // TEMP DIR CREATION
    const TEMP_DIR = "./temp/" + UUID;
    await mkdir(TEMP_DIR, { recursive: true });

    // UNIVERSAL HEADER
    const RefererUrl = "https://www.pixiv.net/artworks/" + artworkId;
    var universalHeader = {
        "User-Agen": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": RefererUrl,
        "Cookie": "PHPSESSID=" + sessionKey + ";",
    };

    /* ======================= INTERNALLY USED FUNCTIONS DEFINE START ======================= */
    async function fetchSave(originalURL, outPath) {
      let fileHandleCreated = false;
      
      try {
        const res = await fetch(originalURL, {
          method: 'GET',
          headers: universalHeader
        });
    
        if (!res.ok) {
          throw new Error(`Request failed: ${res.status} ${res.statusText} for URL: ${originalURL}`);
        }
    
        if (!res.body) {
          throw new Error('Response body is null');
        }
    
        const dir = dirname(outPath);
        await mkdir(dir, { recursive: true });
        
        const fileWriteStream = createWriteStream(outPath);
        fileHandleCreated = true;
    
        await pipeline(res.body, fileWriteStream);
    
        return outPath;
      } catch (err) {
        if (fileHandleCreated) {
          try {
            await unlink(outPath);
          } catch (unlinkErr) {
            console.error(`Failed to delete partial file ${outPath} after error:`, unlinkErr);
          }
        }
        
        throw err;
      }
    }

    async function unzip(targetZip, extractPath) {
      try {
        await mkdir(extractPath, { recursive: true });
    
        const zip = new AdmZip(targetZip);
    
        await new Promise((resolve, reject) => {
          zip.extractAllToAsync(extractPath, true, false, (error) => {
            if (error) {
              return reject(error);
            }
            resolve();
          });
        });
    
      } catch (err) {
        console.error(`Failed to unzip file ${targetZip} to ${extractPath}:`, err);
        throw err;
      }
    }

    async function illustHandler(json) {
        var isFailed = false;
        const downloadPromises = json["body"].map(async (page, index) => {
            const pgNum = index + 1;
            const originalURL = page["urls"]["original"];
            try {
                const resultingPath = await fetchSave(originalURL, TEMP_DIR + "/" + pgNum + ".jpg");
            } catch (error) {
                console.error(`Download failed: ${error.message}`);
                isFailed = true;
            }
        });
        
        await Promise.all(downloadPromises);
        return !isFailed;
    }
    
    async function ugoiraHandler(json) {
        const originalURL = json["body"]["originalSrc"];
        try {
            const zipSavePath = TEMP_DIR + "/data.zip";
            await fetchSave(originalURL, zipSavePath);
            const extractPath = TEMP_DIR + "/extracted";
            await unzip(zipSavePath, extractPath);
            await unlink(zipSavePath);
            const OUTPUT_PATH = TEMP_DIR + "/encoded.gif";
            const CONCAT_FILE_PATH = TEMP_DIR + "/inputs.txt";
            try {
                let concatFileContent = "";
                json["body"]["frames"].forEach(data => { 
                    const fileName = data["file"];
                    const duration = data["delay"] / 1000;
                    const absoluteImagePath = path.resolve(extractPath, fileName);
                    const safePath = absoluteImagePath.replace(/\\/g, '/');
                    concatFileContent += `file '${safePath}'\n`;
                    concatFileContent += `duration ${duration}\n`;
                });
                fs.writeFileSync(CONCAT_FILE_PATH, concatFileContent);
                await new Promise((resolve, reject) => {
                    ffmpeg()
                        .input(CONCAT_FILE_PATH)
                        .inputOptions([
                            '-f', 'concat',
                            '-safe', '0'
                        ])
                        .outputOptions([
                            '-loop', '0'
                        ])
                        .save(OUTPUT_PATH)
                        .on('end', () => {                            
                            try {
                                fs.unlinkSync(CONCAT_FILE_PATH);
                                resolve();
                            } catch (e) {
                                console.error('Failed to delete temp file:', e);
                                reject(e);
                            }
                        })
                        .on('error', (err) => {
                            console.error('Error creating GIF:', err.message);
                            try {
                                fs.unlinkSync(CONCAT_FILE_PATH);
                            } catch (e) {
                                console.error('Failed to delete temp file after error:', e);
                            }
                            reject(err);
                        });
                });
                return true;
            } catch (err) {
                console.error(`Encode failed: ${err.message}`);
            }
        } catch (err) {
            console.error(`Download failed: ${err.message}`);
        }
        return false;
    }

    /* ======================= INTERNALLY USED FUNCTIONS DEFINE END ======================= */

    var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "?lang=ja", 
        { method: "GET", headers: universalHeader });
    var json = res.ok ? await res.json() : null;

    var result = {
        "success": false,
        "data": {},
        "uuid": UUID
    };

    const artworkTypes = {0: "ILLUST", 1: "MANGA", 2: "UGOIRA"};
    const ratingTypes = {0: "ALL_AGE", 1: "R18", 2: "R18G"};

    if ( json ) {
        /* ======================= ARTWORK DATA START ======================= */
        var artworkData = {};

        artworkData["title"] = json["body"]["illustTitle"];
        artworkData["description"] = json["body"]["illustComment"];
        artworkData["is_original"] = json["body"]["isOriginal"];
        artworkData["bookmarks"] = json["body"]["bookmarkCount"];
        artworkData["likes"] = json["body"]["likeCount"];
        artworkData["views"] = json["body"]["viewCount"];
        artworkData["is_ai"] = json["body"]["aiType"] != 1;
        artworkData["created_at"] = json["body"]["createDate"];
        artworkData["type"] = artworkTypes[json["body"]["illustType"]];
        artworkData["rating"] = ratingTypes[json["body"]["xRestrict"]];

        result["data"] = artworkData;
        /* ======================= ARTWORK DATA END ======================= */

        // UGOIRA
        if ( json["body"]["illustType"] == 2 ) 
        {
            var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "/ugoira_meta?lang=ja", { method: "GET", headers: universalHeader });
            res = res.ok ? await res.json() : null;
            if ( res ) {
                result["success"] = await ugoiraHandler(res);
            } 
        } else // Illust or Manga.
        {
            var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "/pages?lang=ja", { method: "GET", headers: universalHeader });
            res = res.ok ? await res.json() : null;
            if ( res ) {
                result["success"] = await illustHandler(res);
            }
        }
    } 
    return result;
}
