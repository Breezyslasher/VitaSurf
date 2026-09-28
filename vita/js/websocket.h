/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/* WebSocket connections for the script engine, on libcurl's ws API. */

#ifndef VITASURF_JS_WEBSOCKET_H
#define VITASURF_JS_WEBSOCKET_H

#include <stdbool.h>
#include <stddef.h>

/** What happened on a connection, as told to its owner. */
enum vws_event {
	VWS_OPEN = 1,		/**< data is the protocol the server chose */
	VWS_TEXT = 2,		/**< a text message, UTF-8 */
	VWS_BINARY = 3,		/**< a binary message */
	VWS_ERROR = 4,		/**< the connection failed; a close follows */
	VWS_CLOSE = 5		/**< closed: code, and data is the reason */
};

/**
 * Called from the scheduler, never from inside vws_* itself. After a
 * VWS_CLOSE the id is gone and nothing more is told about it.
 */
typedef void (*vws_event_cb)(void *owner, int id, enum vws_event ev,
			     const char *data, size_t len, int code);

/**
 * Open a connection to a ws: or wss: URL.
 *
 * \param url        the absolute URL
 * \param origin     sent as Origin, or NULL
 * \param protocols  sent as Sec-WebSocket-Protocol, or NULL or ""
 * \param cookie     sent as Cookie, or NULL
 * \param cb         where events go
 * \param owner      passed back to cb, and names the connections to drop
 *                   with vws_drop_owner
 * \return an id above zero, or -1 when nothing could be started
 */
int vws_open(const char *url, const char *origin, const char *protocols,
	     const char *cookie, vws_event_cb cb, void *owner);

/** Queue a message. False when the connection is not open. */
bool vws_send(int id, const void *data, size_t len, bool binary);

/** Start the closing handshake; the close event comes later. */
void vws_close(int id, int code, const char *reason, size_t reason_len);

/** Close every connection an owner has, silently: its page is going. */
void vws_drop_owner(void *owner);

/** Bytes queued and not yet handed to the connection. */
size_t vws_buffered(int id);

#endif
