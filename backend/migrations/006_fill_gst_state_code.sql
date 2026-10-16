-- 006: GST state code was left empty for hotels that have a GSTIN. It is the first two digits of the GSTIN
-- (e.g. 03 = Punjab) and decides whether invoices split tax into CGST+SGST or IGST.
UPDATE hotels
   SET state_code = left(gstin, 2)
 WHERE gstin ~ '^[0-9]{2}'
   AND (state_code IS NULL OR btrim(state_code) = '');
