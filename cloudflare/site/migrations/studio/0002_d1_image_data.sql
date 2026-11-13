-- Free testing mode: small attachments live in D1, without an R2 subscription.
-- 512 KiB raw images become at most ~700 KiB base64, below D1's 2 MB row limit.
CREATE TABLE IF NOT EXISTS studio_image_data (
  id TEXT PRIMARY KEY REFERENCES studio_images(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(length(data) <= 699052)
);
