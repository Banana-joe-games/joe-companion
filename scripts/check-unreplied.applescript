tell application "Mail"
	set output to ""
	set counter to 0
	-- Only check the most recent 100 messages (fast), then filter by date in Node
	repeat with i from 1 to 100
		try
			set msg to message i of inbox
			set msgDate to date received of msg
			-- Stop if older than 7 days
			if msgDate < ((current date) - (7 * 24 * 3600)) then exit repeat
			-- Only unreplied, already read
			if (was replied to of msg) is false and (read status of msg) is true then
				set senderAddr to sender of msg
				set msgSubject to subject of msg
				set output to output & senderAddr & "|||" & msgSubject & linefeed
				set counter to counter + 1
				if counter >= 20 then exit repeat
			end if
		end try
	end repeat
	return output
end tell
