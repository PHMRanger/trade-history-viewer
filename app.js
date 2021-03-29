const express = require("express");
const app = express();
const axios = require("axios").default;

app.set("view engine", "ejs");
app.use(express.static("public"));

const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("data/store.sqlite");

const refresh_lock = {};
const sleep = (t) => new Promise((res) => setTimeout(() => res(), t));

const PRICE_ENDPOINT = "http://167.172.166.247/api/prices";
const TRADE_ENDPOINT = (key, lastOffer, max = 100, reverse = false) =>
  `http://api.steampowered.com/IEconService/GetTradeHistory/v1?key=${key}${
    lastOffer
      ? `&start_after_tradeid=${lastOffer.tradeid}&start_after_time=${lastOffer.time_init}`
      : ""
  }&max_trades=${max}&get_descriptions=true&include_total=true&navigating_back=${reverse}`;

const migrate = () => {
  db.run(
    "CREATE TABLE trades (" +
      "id bigint PRIMARY KEY," +
      "key varchar NOT NULL," +
      "other bigint NOT NULL," +
      "sent int NOT NULL," +
      "received int NOT NULL," +
      "created_at bigint NOT NULL)",
    () => {}
  );

  db.run(
    "CREATE TABLE prices (" +
      "name varchar NOT NULL," +
      "classid bigint PRIMARY KEY," +
      "price int NOT NULL)",
    () => {}
  );
};

migrate();

let Queries = {
  add_price: db.prepare("INSERT INTO prices VALUES (?, ?, ?)"),
  add_trade: db.prepare("INSERT INTO trades VALUES (?, ?, ?, ?, ?, ?)"),
  get_price: db.prepare("SELECT price FROM prices WHERE name = ?"),
  delete_trades: db.prepare("DELETE FROM trades WHERE key = ?"),
  get_price_fn: (name) => {
    Queries.get_price.reset();
    Queries.get_price.run(name);
    return new Promise((res, rej) =>
      Queries.get_price.all((err, rows) => {
        err && rej(err);
        !err && res(rows[0] ? rows[0].price : null);
      })
    );
  },
  get_trades: db.prepare("SELECT * FROM trades WHERE key = ?"),
  get_trades_fn: (key) => {
    Queries.get_trades.reset();
    Queries.get_trades.run(key);
    return new Promise((res, rej) => {
      Queries.get_trades.all((err, rows) => {
        err && rej(err);
        !err && res(rows);
      });
    });
  },
  cached_trades(key) {
    return new Promise((res, rej) => {
      const results = [];
      db.each(`SELECT id FROM trades WHERE key = ${key}`, (err, row) => {
        err && rej(err);
        !err && row && results.push(row);
      });
      res(results);
    });
  },
};

const update_prices = async () => {
  db.run("DELETE FROM prices");

  const { data } = await axios.get(PRICE_ENDPOINT);

  for (const { name, classid, price } of data) {
    const rounded = Math.floor(price * 100);
    classid && rounded && Queries.add_price.run(name, classid, rounded);
  }
};

// setTimeout(() => update_prices(), 1e3);

const trade_price_total = async (items, desc_map) => {
  if (!items || !items.length) {
    return 0;
  }

  const queries = items.map(({ classid }) => {
    return Queries.get_price_fn(desc_map[classid]);
  });

  const all = await Promise.all(queries);
  const filtered = all.filter((x) => x != null);

  return filtered.length ? filtered.reduce((a, b) => a + b) : 0;
};

const process_trade = async (trade, desc_map) => {
  const [given, received] = [
    await trade_price_total(trade.assets_given, desc_map),
    await trade_price_total(trade.assets_received, desc_map),
  ];

  return {
    id: trade.tradeid,
    other: trade.steamid_other,
    sent: given,
    received: received,
    created_at: trade.time_init,
  };
};

const make_desc_map = (desc) => {
  const xs = {};
  for (const { classid, market_hash_name } of desc) {
    xs[classid] = market_hash_name;
  }
  return xs;
};

const fetch_all_trades = async (key) => {
  let started = 0;
  let last;
  let counter = 0;
  let total_trades;
  for (;;) {
    const max = total_trades ? Math.min(100, total_trades - counter) : 100;
    if (max < 100) {
      last = undefined;
    }

    const { data } = await axios.get(TRADE_ENDPOINT(key, last, max, max < 100));

    console.log({
      max,
      total_trades,
      counter,
      more: data.response.more,
    });

    if (data.response.more === false || max <= 0) {
      break;
    }

    if (!data.response.more) {
      await sleep(5000);
      continue;
    }

    total_trades = data.response.total_trades;
    const trades = data.response.trades;
    const desc_list = data.response.descriptions;
    const desc_map = make_desc_map(desc_list);

    const { tradeid, time_init } = trades[trades.length - 1];
    last = { tradeid, time_init };

    for (const trade of trades) {
      const { id, other, sent, received, created_at } = await process_trade(
        trade,
        desc_map
      );

      Queries.add_trade.run(id, key, other, sent, received, created_at);
    }

    counter += 100;
    await sleep(200);
  }

  const took = Math.floor((Date.now() - started) / 1000);

  return [total_trades, took];
};

app.post("/:key/refresh", async (req, res) => {
  const { key } = req.params;

  if (refresh_lock[key]) {
    return res.status(402).send("already refreshing");
  }

  refresh_lock[key] = true;
  Queries.delete_trades.run(key);

  try {
    const [count, took] = await fetch_all_trades(key);
    res.redirect(303, `/${key}`);
  } catch (e) {
    res.render("error", { error: e.message });
  }

  refresh_lock[key] = false;
});

app.get("/:key", async (req, res) => {
  const { key } = req.params;
  const trades = await Queries.get_trades_fn(key);

  res.render("index", { trades, key });
});

app.get("/price/:classid", async (req, res) => {
  const { classid } = req.params;

  res.send(`${await Queries.get_price_fn(classid)}`);
});

const PORT = 8902;
app.listen(PORT, () => {
  console.log(`🔎 Investigation started on port ${PORT}.`);
});
