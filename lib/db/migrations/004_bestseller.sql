-- D-26: the restaurant's own bestseller mark, set by staff in the admin menu. It is the only popularity evidence the
-- chatbot may cite: the data has no sales figures, ratings or reviews. Default 0, so nothing is marked until staff do.
ALTER TABLE menu_items ADD COLUMN is_bestseller INTEGER NOT NULL DEFAULT 0 CHECK (is_bestseller IN (0,1));
