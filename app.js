import { createWriteStream } from 'fs';
import { unlink, mkdir, writeFile, stat } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { dirname, resolve as resolvePath } from 'path';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import readline from 'readline';
import AdmZip from 'adm-zip';

import ffmpeg from 'fluent-ffmpeg';
import { exit } from 'process';

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

var universalHeader = {
    "User-Agen": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.pixiv.net/",
    "Cookie": "PHPSESSID=" + PHPSESSID + ";",
};

const IID = await ask("Illust Id? ");
const result = await saveIllust(IID);
if ( result["success"] ) {
    console.log("✅ " + result["type"] + "「" +  result["data"]["title"] + "」のダウンロード成功");
    console.log("データー：\n" + JSON.stringify(result["data"]));
    console.log("-=".repeat(11).slice(1));
}

async function saveIllust(IID) {
    const URL_BASE = "https://www.pixiv.net/artworks/" + IID;

    universalHeader["Referer"] = URL_BASE;

    var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "?lang=ja", { method: "GET", headers: universalHeader });
    var json = res.ok ? await res.json() : null;

    var result = {
        "success": false,
        "data": {},
        "type": null
    };

    if ( json ) {
        // 0=illust 1=manga 2=ugoira
        const artworkTypes = {0: "ILLUST", 1: "MANGA", 2: "UGOIRA"};

        const isUgoira = json["body"]["illustType"] == 2;

        // meta data
        result["type"] = artworkTypes[json["body"]["illustType"]];

        var artworkData = {};
        const ratings = {0: "ALL_AGE", 1: "R18", 2: "R18G"};

        artworkData["title"] = json["body"]["illustTitle"];
        artworkData["description"] = json["body"]["illustComment"];
        artworkData["is_original"] = json["body"]["isOriginal"];
        artworkData["bookmarks"] = json["body"]["bookmarkCount"];
        artworkData["likes"] = json["body"]["likeCount"];
        artworkData["views"] = json["body"]["viewCount"];
        artworkData["is_ai"] = json["body"]["aiType"] != 1;
        artworkData["rating"] = ratings[json["body"]["xRestrict"]];
        artworkData["created_at"] = json["body"]["createDate"];

        result["data"] = artworkData;
        // end

        if ( isUgoira ) {
            var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "/ugoira_meta?lang=ja", { method: "GET", headers: universalHeader });
            var json = res.ok ? await res.json() : null;
            if ( json ) {
                const originalURL = json["body"]["originalSrc"];
                try {
                    const savePath = "./ugoira/" + IID + "/data.zip";
                    const resultingPath = await fetchSave(originalURL, savePath);
                    console.log(`Success! Ugoira saved to: ${resultingPath}`);
                    await unzip(savePath, "./ugoira/" + IID + "/extracted");

                    const BASE_PATH = "./ugoira/" + IID + "/extracted/";
                    const OUTPUT_PATH = "./ugoira/" + IID + "/encoded.gif";
                    const CONCAT_FILE_PATH = "./ugoira/" + IID + "/inputs.txt";

                    try {
                        let concatFileContent = "";
                        json["body"]["frames"].forEach(data => { 
                            const fileName = data["file"];
                            const duration = data["delay"] / 1000;

                            const absoluteImagePath = path.resolve(BASE_PATH, fileName);
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
                                    console.log('GIF creation finished: ' + OUTPUT_PATH);
                                    
                                    try {
                                        fs.unlinkSync(CONCAT_FILE_PATH);
                                        result["success"] = true;
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

                    } catch (error) {
                        console.error(`Encode failed: ${error.message}`);
                    }
                } catch (error) {
                    console.error(`Download failed: ${error.message}`);
                }
            }
        } else {
            var res = await fetch("https://www.pixiv.net/ajax/illust/" + IID + "/pages?lang=ja", { method: "GET", headers: universalHeader });
            var json = res.ok ? await res.json() : null;
            if ( json ) {
                var isFailed = false;

                const downloadPromises = json["body"].map(async (page, index) => {
                    const pgNum = index + 1;
                    const originalURL = page["urls"]["original"];
                    try {
                        const resultingPath = await fetchSave(originalURL, "./images/" + IID + "/" + pgNum + ".jpg");
                        console.log(`Success! Image saved to: ${resultingPath}`);
                    } catch (error) {
                        console.error(`Download failed: ${error.message}`);
                        isFailed = true;
                    }
                });

                await Promise.all(downloadPromises);
                result["success"] = !isFailed; 
            }
        } 
    } 
    
    return result; 
}

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
