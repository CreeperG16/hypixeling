import { config } from "dotenv";
config();

import { Client, Player } from "hypixel.ts";
import fs from "node:fs";
import data from "./1.12.2.json" with { type: "json" };

const assets1_12 = await import("minecraft-assets").then((x) => x.default("1.12"));
const assets1_21 = await import("minecraft-assets").then((x) => x.default("1.21.4"));

const COLOURS = {
    FARMING: 0xe0c878,
    MINING: 0x8c8c8c,
    COMBAT: 0xe74c3c,
    FORAGING: 0x27ae60,
    FISHING: 0x3498db,
    RIFT: 0x9b59b6,
};

// Check every five minutes
const FETCH_INTERVAL = 5 * 60 * 1000;

class SkyblockUpdateNotifier {
    /** @type {Client} @readonly */
    client = new Client({ apiKeys: [process.env.HYPIXEL_DEV_API_KEY] }).start();

    /** @type {Map<string, Awaited<ReturnType<typeof Client.prototype.skyblock.fetchItems>>["items"][number]>} @readonly */
    skyblockItems = new Map();

    /** @type {Map<string, unknown>} @readonly */
    collectionItems = new Map();

    /** @type {Map<string, { name: string; discord?: string }>} @readonly  */
    coopMembers = new Map();

    /** @type {Player} @readonly */
    player;

    /** @type {Record<string, number>} @readonly */
    collectionProgress;

    /** @type {Record<string, { name: string; text_id: string }>} @readonly */
    itemData = data[0].items.item;

    async mapCollections() {
        const { collections } = await this.client.skyblock.fetchCollections();

        for (const [type, collection] of Object.entries(collections)) {
            // console.log(type);
            // console.log(type, collection);
            for (const [item, details] of Object.entries(collection.items)) {
                this.collectionItems.set(item, {
                    item,
                    collection_name: collection.name,
                    collection: type,
                    collection_colour: COLOURS[type],
                    ...details,
                });
            }
        }
    }

    getTierFromAmount(item, amount) {
        const collectionData = this.collectionItems.get(item);
        for (const [i, tier] of collectionData.tiers.entries()) {
            if (tier.amountRequired > amount) return i === 0 ? 0 : collectionData.tiers.at(i - 1).tier;
        }
        return collectionData.tiers.at(-1).tier;
    }

    sumCollection(collections) {
        const fullCollections = {};
        for (const collection of collections) {
            if (!collection) continue;
            for (const [item, amount] of Object.entries(collection)) {
                fullCollections[item] ??= 0;
                fullCollections[item] += amount;
            }
        }
        return fullCollections;
    }

    /** @param {string[]} memberIDs */
    async updateMembers(memberIDs) {
        for (const id of memberIDs) {
            if (this.coopMembers.has(id)) continue;
            const player = await this.client.players.fetch(id);
            // console.log(Object.keys(profile));
            this.coopMembers.set(id, { name: player.displayname, discord: player.socialMedia?.links?.DISCORD });
        }
    }

    async checkForDifferences(newCollections, newSum) {
        const oldCollections = await fs.promises
            .readFile("./collections.json", "utf-8")
            .then((x) => JSON.parse(x).collections);

        const oldSum = this.sumCollection(oldCollections.map((x) => x.collection));

        for (const [item, newAmount] of Object.entries(newSum)) {
            const oldAmount = oldSum[item];
            if (newAmount === oldAmount) continue;

            const contributed = [];
            console.log(item, oldSum[item], newSum[item]);

            for (const newCollection of newCollections) {
                const oldCollection = oldCollections.find((x) => x.player.name === newCollection.player.name);
                if (!oldCollection) continue;

                const player = oldCollection.player;
                const oldPlayerAmount = oldCollection.collection?.[item] ?? null;
                const newPlayerAmount = newCollection.collection?.[item] ?? null;

                // console.log(player.name, item, oldPlayerAmount, newPlayerAmount);

                if (oldPlayerAmount === newPlayerAmount) continue;
                contributed.push({ player, oldAmount: oldPlayerAmount, newAmount: newPlayerAmount });

                // if (!newCollection.collection) continue;
                // console.log(oldCollection.player.name, oldCollection.collection?.[item], newCollection.collection?.[item]);
                // console.log(c, Object.keys(oldCollections), Object.keys(newCollections));
                // if (!c || !c.collection) continue;
                // console.log(c.player, oldCollections[c.player].collection[item], c.collection[item]);
            }

            // console.log("contributed:", contributed);

            const oldTier = this.getTierFromAmount(item, oldAmount);
            const newTier = this.getTierFromAmount(item, newAmount);

            if (oldTier === newTier) continue;

            await this.onNewTier(item, newTier, contributed);

            // console.log("New tier!", this.getTier(item, newTier));

            // this.getTier(item, 1);
        }
    }

    async onNewTier(item, tier, contributed) {
        const itemData = this.collectionItems.get(item);
        const moreItemData = this.skyblockItems.get(item);
        const tierData = this.getTier(item, tier);
        // console.log(`New tier in ${itemData.name}:`, tierData);
        // console.log("Players who reached the tier:", contributed);
        // console.log(itemData, moreItemData);

        await this.sendWebhook([this.collectionTierEmbed({ ...itemData, ...moreItemData }, tierData, contributed)]);
    }

    collectionTierEmbed(item, tier, players) {
        // console.log(item, tier, players);
        const iconurl = this.getTextureUrl(item);
        console.log(item, iconurl);

        return {
            title: `${item.name}: Reached tier ${tier.tier}`,
            thumbnail: { url: iconurl },
            footer: {
                text: players.map((x) => x.player.name).join(", "),
                icon_url: `https://mc-heads.net/avatar/${players[0].player.name}`,
            },
            description: `-# ${item.collection_name} Collection\n` + tier.unlocks.map((x) => "- " + x).join("\n"),
            color: item.collection_colour,
            timestamp: new Date(),
        };
    }

    async sendWebhook(components) {
        const url = process.env.WEBHOOK_URL;
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: components }),
        });

        console.log("Webhook response status:", res.status, res.statusText);
        if (!res.ok) console.log(await res.text());
    }

    getTier(item, tier) {
        console.log(item, tier)
        if (tier === 0) return { tier: 0, amountRequired: 1, unlocks: [] };
        return this.collectionItems.get(item).tiers.find((x) => x.tier === tier);
    }

    async updateProfile() {
        const profiles = await this.player.fetchSkyBlockProfiles(); // TODO: what's the rate limit on this?
        const skyblock = profiles.find((x) => x.profile_id === process.env.SKYBLOCK_PROFILE_ID);
        const members = Object.values(skyblock.members);

        await this.updateMembers(members.map((x) => x.player_id));

        this.collectionProgress = this.sumCollection(members.map((x) => x.collection));

        // console.log(collectionItems.get("LOG:1"));
        // console.log("Profile has reached:", getCollectionTier(collectionItems.get("LOG:1"), collections["LOG:1"]));

        const perPlayer = members.map((x) => ({
            player: this.coopMembers.get(x.player_id),
            collection: x.collection ?? null,
        }));
        // console.log(perPlayer.map(x => x.player.name));
        // console.log(perPlayer);

        await this.checkForDifferences(perPlayer, this.collectionProgress);

        await fs.promises.writeFile("./collections.json", JSON.stringify({
            lastUpdated: new Date(),
            collections: perPlayer,
        }, null, 4));
    }

    getTextureFromAssets(item) {
        const itemOrBlock1_12 = assets1_12.findItemOrBlockByName(item);
        const itemOrBlock1_21 = assets1_21.findItemOrBlockByName(item);

        if (!itemOrBlock1_12 && !itemOrBlock1_21) return;

        const texture = (itemOrBlock1_21 ?? itemOrBlock1_12).texture.replace("minecraft:", "");
        return `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/refs/heads/master/data/${!!itemOrBlock1_21 ? "1.21.4" : "1.12"}/${texture}.png`;
    }

    getTextureUrl(item) {
        if (typeof item.skin !== "undefined") {
            const data = JSON.parse(Buffer.from(item.skin.value, "base64").toString("utf-8"));
            const id = data.textures.SKIN.url.split("/").at(-1);
            return "https://mc-heads.net/head/" + id;
        }

        // yeah idk this is very jank, the whole textures system is very jank
        // ironic that it's specifically vanilla textures that are hard to get
        // hypixel's custom stuff is easy

        let vanillaName = Object.values(this.itemData).find((x) => x.name === item.material.toLowerCase())?.text_id;
        if (!vanillaName) {
            console.log("could not find vanilla for", item.material);
            vanillaName = item.material.toLowerCase();
        }

        return this.getTextureFromAssets(vanillaName);

        // const texturePath = await fetch()

        // if (!vanillaName) {
        //     console.log("could not find vanilla for ", item.material);
        //     return (
        //         "https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/" +
        //         assets.getTexture(item.material.toLowerCase()) +
        //         ".png"
        //     )
        // };

        // const itemOrBlock = assets.findItemOrBlockByName(vanillaName);
        // if (!itemOrBlock) return;

        // return (
        //     "https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/refs/heads/master/data/1.21.4/" +
        //     assets1_12.getTexture(vanillaName) +
        //     ".png"
        // );
    }

    async main() {
        // await this.client.players.getStatus("_samat").then(console.log);

        // const collectionItems = await mapCollections();
        // console.log(collectionItems.get("LOG:1"));

        const { items } = await this.client.skyblock.fetchItems();
        for (const item of items) this.skyblockItems.set(item.id, item);

        // console.log(items.find((x) => !!x.skin));
        // console.log(Object.keys(items[0]));

        this.player = await this.client.players.fetch("_samat");
        await this.mapCollections();

        await this.updateProfile();

        // this.updateProfile();
        setInterval(async () => {
            console.log("Checking for updates...");
            await this.updateProfile();
        }, FETCH_INTERVAL);
    }
}

// console.dir(members, { depth: 1 });
// console.log(members.map(x => x.leveling));
// console.log(collections.FORAGING.items["LOG:1"]);

const program = new SkyblockUpdateNotifier();
program.main();
