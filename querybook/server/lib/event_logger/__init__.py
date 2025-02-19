from flask_login import current_user

from const.event_log import EventType
from env import QuerybookSettings
from lib.event_logger.all_event_loggers import get_event_logger_class
from lib.logger import get_logger

LOG = get_logger(__file__)


class EventLogger:
    def __init__(self):
        logger_name = QuerybookSettings.EVENT_LOGGER_NAME
        self.logger = get_event_logger_class(logger_name)

    def log(
        self,
        event_type: EventType,
        event_data: dict,
    ):
        try:
            self.logger.log(
                uid=current_user.id, event_type=event_type, event_data=event_data
            )
        except Exception as e:
            # catch any potential exceptions to avoid event logging
            # from interrupting the normal flow
            LOG.error(e, exc_info=True)

    def log_api_request(self, route: str, method: str, params: dict):
        try:
            self.logger.log_api_request(
                uid=current_user.id, route=route, method=method, params=params
            )
        except Exception as e:
            LOG.error(e, exc_info=True)


event_logger = EventLogger()
